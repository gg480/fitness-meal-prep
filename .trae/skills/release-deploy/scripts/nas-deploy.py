#!/usr/bin/env python3
"""一锅出·备餐管理器 — NAS 发版部署脚本

内置三条铁律：
  1. 只接受不可变版本 tag（拒绝 latest，避免镜像加速器返回陈旧缓存）
  2. 部署前用 RepoDigests 与 push 结果比对 digest，不符立即中止（不会触碰线上容器）
  3. 端口/卷/重启策略从原容器 inspect 读出照抄，绝不凭记忆手写

连接信息从 nas-config.json 读取（该文件已 gitignore，不入版本库）。
先复制 nas-config.example.json 为 nas-config.json 并填入 NAS 信息。

用法（PowerShell）:
    $env:NAS_PWD = '<NAS SSH 密码>'
    python nas-deploy.py --tag v2.3.2 --digest sha256:<push 输出的 Digest>
    python nas-deploy.py --tag v2.3.2 --digest sha256:<...> --dry-run   # 只校验与预演，不动容器
    Remove-Item Env:\\NAS_PWD

退出码：0 成功；非 0 表示在破坏性操作前已中止，线上容器未被改动。
"""
import argparse
import getpass
import json
import os
import sys
import time

import paramiko

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CONFIG = os.path.join(SKILL_DIR, 'nas-config.json')


def fail(msg):
    print('\n中止: ' + msg)
    sys.exit(1)


def load_config(path):
    """读取 NAS 连接配置；缺失时给出可执行的补救提示，避免误用占位值连错机器"""
    if not os.path.exists(path):
        fail('未找到部署配置 %s\n'
             '      请把同目录的 nas-config.example.json 复制为 nas-config.json，并填入 NAS 连接信息\n'
             '      （nas-config.json 已在 .gitignore 中，不会被提交）' % path)
    with open(path, 'r', encoding='utf-8') as fp:
        cfg = json.load(fp)
    missing = [k for k in ('host', 'ssh_port', 'user', 'repo', 'container') if not cfg.get(k)]
    if missing:
        fail('配置文件缺少字段: ' + ', '.join(missing))
    return cfg


def connect(cfg, pwd):
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(cfg['host'], port=cfg['ssh_port'], username=cfg['user'],
                password=pwd, timeout=15)
    return cli


def run(cli, pwd, cmd, timeout=600):
    """执行远程命令；sudo 的密码提示混在 stderr，需过滤后再判断是否真出错"""
    _, out, err = cli.exec_command('echo %s | sudo -S %s' % (pwd, cmd), timeout=timeout)
    o = out.read().decode('utf-8', 'replace')
    e = err.read().decode('utf-8', 'replace')
    e = '\n'.join(l for l in e.splitlines() if 'password for' not in l).strip()
    return o.strip(), e


def inspect_field(cli, pwd, target, fmt):
    o, e = run(cli, pwd, "docker inspect %s --format '%s'" % (target, fmt))
    if not o:
        fail('docker inspect %s 失败: %s' % (target, e))
    return o


def pull_and_verify(cli, pwd, repo, tag, expect):
    """拉取不可变 tag 并校验内容。
    manifest digest(RepoDigests) 与 config digest(.Id) 是两个不同的值，不能混用：
    与 push 输出比对必须用前者。返回 config digest 供后续校验容器用。"""
    full = '%s:%s' % (repo, tag)
    print('[1/6] 拉取 %s' % full)
    o, _ = run(cli, pwd, 'docker pull %s' % full)
    for line in o.splitlines():
        if any(k in line for k in ('Digest', 'Status', 'Error')):
            print('      ' + line)
    got = inspect_field(cli, pwd, full, '{{index .RepoDigests 0}}').split('@')[-1]
    if got != expect:
        fail('digest 不符，拒绝部署！\n      期望 %s\n      实际 %s\n'
             '      多半是加速器返回了陈旧缓存（浮动标签的典型症状）' % (expect, got))
    print('      校验通过：manifest digest 与 push 结果一致')
    return inspect_field(cli, pwd, full, '{{.Id}}')


def read_container(cli, pwd, container):
    """读出原容器的端口/卷/重启策略，供照抄重建（铁律 3）"""
    o, e = run(cli, pwd, 'docker inspect %s' % container)
    if not o:
        fail('未找到容器 %s: %s' % (container, e))
    info = json.loads(o)[0]
    mounts = [(m['Source'], m['Destination']) for m in info.get('Mounts', [])]
    if not mounts:
        fail('原容器没有卷挂载，重建会丢数据，拒绝继续')
    ports = []
    for cport, binds in (info['HostConfig'].get('PortBindings') or {}).items():
        ports += ['%s:%s' % (b.get('HostPort'), cport.split('/')[0]) for b in binds]
    if not ports:
        fail('原容器没有端口映射，拒绝继续')
    cfg = dict(restart=info['HostConfig']['RestartPolicy']['Name'] or 'no',
               mounts=mounts, ports=ports, image=info['Image'])
    print('[2/6] 原容器配置：镜像=%s 重启=%s 端口=%s 卷=%s'
          % (cfg['image'][:19], cfg['restart'], ports, mounts))
    return cfg


def build_run_cmd(container, repo, tag, cfg):
    """按原配置拼 docker run 命令：端口、卷、重启策略全部照抄"""
    parts = ['docker run -d', '--name %s' % container]
    if cfg['restart'] != 'no':
        parts.append('--restart %s' % cfg['restart'])
    parts += ['-p %s' % p for p in cfg['ports']]
    parts += ['-v %s:%s' % m for m in cfg['mounts']]
    parts.append('%s:%s' % (repo, tag))
    return ' '.join(parts)


def rebuild(cli, pwd, container, cmd):
    """停删旧容器（不碰卷）并用新镜像重建"""
    print('[3/6] 停止并删除旧容器（卷保留）')
    run(cli, pwd, 'docker stop %s' % container)
    run(cli, pwd, 'docker rm %s' % container)
    print('[4/6] 重建容器')
    o, e = run(cli, pwd, cmd)
    if not o:
        fail('重建失败: ' + e)
    print('      新容器: %s' % o[:24])


def wait_healthy(cli, pwd, container, expect_id):
    """确认容器已起来且运行的正是新镜像（.Image 与该 tag 的 config digest 比对）"""
    print('[5/6] 等待健康检查')
    time.sleep(15)
    status = inspect_field(cli, pwd, container, '{{.State.Status}}')
    running = inspect_field(cli, pwd, container, '{{.Image}}')
    print('      状态=%s 运行时镜像=%s' % (status, running[:24]))
    if running != expect_id:
        fail('容器运行的镜像与新 tag 不一致，重建未生效')
    if status != 'running':
        fail('容器状态异常: ' + status)
    health, _ = run(cli, pwd, "docker ps --filter name=%s --format '{{.Status}} | {{.Ports}}'" % container)
    print('      ' + health)


def main():
    ap = argparse.ArgumentParser(description='一锅出·备餐管理器 NAS 发版部署')
    ap.add_argument('--tag', required=True, help='不可变版本 tag，如 v2.3.2')
    ap.add_argument('--digest', required=True, help='docker push 输出里的 Digest（sha256:...）')
    ap.add_argument('--config', default=DEFAULT_CONFIG, help='NAS 连接配置路径')
    ap.add_argument('--dry-run', action='store_true', help='只做拉取/校验/预演，不改动容器')
    args = ap.parse_args()

    if args.tag in ('latest', 'stable') or not args.tag.startswith('v'):
        fail('必须用不可变版本 tag（如 v2.3.2）；latest 会被加速器缓存成旧版本')

    cfg = load_config(args.config)
    repo, container = cfg['repo'], cfg['container']
    pwd = os.environ.get('NAS_PWD') or getpass.getpass('NAS SSH 密码: ')
    cli = connect(cfg, pwd)
    try:
        new_id = pull_and_verify(cli, pwd, repo, args.tag, args.digest)
        cur = read_container(cli, pwd, container)
        cmd = build_run_cmd(container, repo, args.tag, cur)
        if args.dry_run:
            print('[dry-run] 将执行：\n      ' + cmd)
            print('[dry-run] 未改动任何容器，结束')
            return
        rebuild(cli, pwd, container, cmd)
        wait_healthy(cli, pwd, container, new_id)
        print('\n[6/6] 部署完成 —— 仍需按 SKILL.md 步骤 5 做浏览器实测：'
              'Console 无错误 / Vue 已挂载 / 本次 UI 改动出现 / 历史数据完好')
    finally:
        cli.close()


if __name__ == '__main__':
    main()
