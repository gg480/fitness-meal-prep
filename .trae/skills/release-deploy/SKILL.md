---
name: "release-deploy"
description: "一锅出·备餐管理器（fitness-meal-prep）的发版部署规范：镜像构建推送、NAS 拉取重建、部署前后校验与故障排查。Invoke when 用户要求发版/部署/上线/更新 NAS 上的健身助手，或说「发版」「部署到 NAS」「更新线上版本」。"
---

# 一锅出 · 备餐管理器 — 发版部署规范

本 Skill 定义本项目的发版全流程与铁律。**每次发版必须完整走完，不得跳步。**

## 何时使用

- 用户说「发版」「部署」「上线」「更新 NAS 上的版本」
- 代码改动需要在 NAS 上生效
- 排查「页面还是旧的 / 白屏 / 数据没更新」等发布类问题

## 三条铁律（违反会直接导致事故）

### 铁律 1：只用不可变版本 tag，永远不要用 `latest`

NAS 的 Docker 配了国内镜像加速器（`registry.zenithspace.net`、`docker.xuanyuan.me`、`dockerpull.org`、`docker.ketches.cn`），它们**会缓存浮动标签 `latest` 的旧 manifest 且长时间不刷新**。

> 实证：推送 `latest` → digest `A`，几分钟后在 NAS 上 `docker pull latest` 拿到的却是 **12 小时前**的旧 manifest。改用不可变 tag 拉取，立刻拿到正确的 `A`。

**规范**：发版打 `v<版本>.<补丁号>`（如 `v2.3.2`）这类不可变 tag，拉取与容器运行都用它。`latest` 可以顺手推一份，但**绝不作为部署依据**。

### 铁律 2：部署前必须校验 digest，不符立即中止

`docker pull` 之后必须比对 `docker inspect <tag> --format '{{.Id}}'` 与本地构建推送时得到的 digest。**不一致 = 拉到了陈旧或错误的内容，立即终止，不得继续删除容器。**

> 这条校验已实际拦下过一次错误部署（拉 `latest` 拿到 12 小时前的旧镜像）。

### 铁律 3：卷的宿主路径一字不改

SQLite 数据在宿主机卷里，删容器不删卷 → 数据不丢。但**重建时卷路径必须完全照抄原容器**，否则连到空库，用户会以为历史数据全丢了。

**做法**：重建前先 `docker inspect <容器>` 读出现有 `Mounts` / `PortBindings` / `RestartPolicy`，用读到的值拼 `docker run`，不要凭记忆手写。

## 环境参数（不入版本库）

连接信息存放在 `.trae/skills/release-deploy/nas-config.json`，**该文件已 gitignore** —— 含 NAS 主机、SSH 账号等基础设施信息，不应提交到仓库（本项目有 GitHub 远端 `github.com/gg480/fitness-meal-prep`）。

首次使用需从模板复制并填值：

```powershell
Copy-Item .trae/skills/release-deploy/nas-config.example.json `
          .trae/skills/release-deploy/nas-config.json
```

| 字段 | 说明 |
|---|---|
| `host` / `ssh_port` / `user` | NAS SSH 连接信息 |
| `repo` | Docker Hub 仓库名，**账号名带 `l` 前缀**（写成 `runningmjgoat` 会 push 无权限） |
| `container` | 容器名 |

**端口映射、数据卷、重启策略不写进配置** —— 脚本从现有容器 `docker inspect` 读出（铁律 3），避免手写漂移。

NAS 上所有 docker 命令都需要 sudo：`echo <密码> | sudo -S docker <子命令>`（脚本已封装）。

**SSH 密码每次运行时向用户索取**（环境变量 `NAS_PWD` 或交互输入），**任何情况下都不写入文件**。

## 发版流程

### 步骤 1：确认可发布

```powershell
git status --short          # 必须无未提交改动，或将本次改动提交
cd frontend; npm run build  # 本地构建过一遍，确保 SFC 能编译
cd ..; node --check backend/src/db.js   # 后端语法
```

> 半成品代码（如引用了未导出的变量）**不会导致构建失败**，但会在浏览器运行时抛 ReferenceError，Vue 挂载失败造成整页白屏（后端 API 仍正常）。所以构建通过 ≠ 代码没问题，必须做步骤 5 的浏览器验证。

### 步骤 2：确定版本号

主版本跟随 [SPEC.md](SPEC.md) 标题里的版本（如 `SPEC v2.3`），补丁号每次发版递增：`v2.3.1` → `v2.3.2`。

### 步骤 3：构建并推送（双 tag）

```powershell
docker build -t lrunningmjgoat/fitness-meal-prep:latest `
             -t lrunningmjgoat/fitness-meal-prep:v2.3.2 .
docker push lrunningmjgoat/fitness-meal-prep:latest
docker push lrunningmjgoat/fitness-meal-prep:v2.3.2
```

**记下 push 输出里的 `Digest: sha256:...`** —— 这是步骤 4 校验用的期望值。

> 注意：`docker pull` 输出里的 manifest digest 与 `docker inspect --format '{{.Id}}'` 的 config digest **不是同一个值**，两者不同属正常，别误判为失败。

### 步骤 4：在 NAS 上部署

用本 Skill 自带脚本（已内置三条铁律的校验）。**先干跑确认无误**（拉取+校验+预演命令，不触碰容器）：

```powershell
$env:NAS_PWD = '<向用户索取的密码>'
python .trae/skills/release-deploy/scripts/nas-deploy.py --tag v2.3.2 --digest sha256:<步骤3的digest> --dry-run
```

干跑输出的 `docker run` 命令要**肉眼核对卷路径**，确认与预期一致后再正式执行：

```powershell
python .trae/skills/release-deploy/scripts/nas-deploy.py --tag v2.3.2 --digest sha256:<步骤3的digest>
Remove-Item Env:\NAS_PWD   # 用完即清
```

脚本依次：拉取不可变 tag → 校验 digest（不符即中止，不碰线上）→ 读原容器配置 → 停删旧容器（不碰卷）→ 照抄配置重建 → 等健康并确认容器运行的是新镜像。

### 步骤 5：验证（不可跳过）

**必须用实测证据，不能凭"应该好了"下结论。**（`$nas` 换成配置里的 host）

```powershell
$nas = 'http://<nas-config.json 里的 host>:19881'

# 5.1 bundle 哈希：与本地前端构建产出的文件名比对，不同即未生效
$h = (Invoke-WebRequest "$nas/" -UseBasicParsing).Content
[regex]::Match($h, '/assets/index-[^"]+\.js').Value

# 5.2 历史数据完好
$r = Invoke-RestMethod "$nas/api/recipes"
"配方数: " + @($r.data).Count
$dl = Invoke-RestMethod "$nas/api/day-logs"
"打卡天数: " + @($dl.data.PSObject.Properties).Count
$w = Invoke-RestMethod "$nas/api/weights"
"体重记录: " + @($w.data).Count
```

5.3 **浏览器实测**：用 Playwright 打开 `$nas`，确认
- Console **无错误**（白屏问题一定伴随 JS 运行时错误）
- Vue 已挂载：`document.querySelector('#app').innerHTML.length > 500`
- 本次改动的具体 UI 元素确实出现

### 步骤 6：收尾

- 同步 [SPEC.md](SPEC.md) 对应章节（数据模型 / API / 页面规格）
- git 提交
- 若本次有踩坑，补进项目记忆

## 故障排查

| 现象 | 排查 | 结论 |
|---|---|---|
| 页面白屏但 API 正常 | 浏览器 Console 看 JS 报错 | 前端运行时错误致 Vue 挂载失败；查 bundle 是否为新包 |
| 拉了镜像还是旧页面 | 比对 `/[assets/index-*.js]` 哈希；`docker inspect <容器> --format '{{.Image}}'` vs `docker inspect <tag> --format '{{.Id}}'` | 容器没换镜像，或加速器给了陈旧 `latest` |
| `docker pull` 拿到的 digest 不是刚推的 | 改用不可变 tag 重拉，比对 digest | 加速器缓存了浮动标签 |
| 数据"丢失" | 检查卷的宿主路径是否与原来一致 | 挂错目录连到空库，旧数据仍在原路径 |
| 极空间界面重建后仍是旧版 | 极空间同 tag 重拉**不会自动切换**已存在容器的镜像 | 必须删容器再用新镜像重建（或用本 Skill 脚本） |

## 常见误区

- ❌ 「我拉取了镜像」= 已部署 → **拉取 ≠ 容器换镜像**，必须重建容器
- ❌ 靠 `latest` 部署 → 加速器可能给旧缓存，必须用不可变 tag
- ❌ 构建通过就认为没问题 → 需浏览器实测才能确认无运行时错误
- ❌ 重建时凭记忆写卷路径 → 必须 `docker inspect` 读出来照抄
- ❌ 用 `docker images` 的 `.ID` 与 pull 的 `Digest` 直接比较 → 两者含义不同
