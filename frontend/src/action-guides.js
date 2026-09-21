// action-guides.js — 动作要领中文指引（v3.2）
// 数据源：ExerciseDB（免费非商用授权，180p 动图 + 英文 instructions），
// 中文要点为基于英文 instructions + 器械适配的二次创作，每个动作 3 条左右，突出「标准姿态 + 呼吸」。
// gif 字段指向同目录同名动图（vite 构建打进 bundle，ExerciseDB 来源见 scripts/fetch_actions.py）

// webpack/vite 下 require(new URL) 动态导入不友好，这里静态 import 由 vite 按 key 解析
import goblet_squat from './assets/actions/goblet_squat.gif';
import db_bench from './assets/actions/db_bench.gif';
import db_row_bench from './assets/actions/db_row_bench.gif';
import rdl from './assets/actions/rdl.gif';
import lateral_raise from './assets/actions/lateral_raise.gif';
import dead_bug from './assets/actions/dead_bug.gif';
import bulgarian_split_squat from './assets/actions/bulgarian_split_squat.gif';
import half_kneel_press from './assets/actions/half_kneel_press.gif';
import bent_over_row from './assets/actions/bent_over_row.gif';
import single_leg_rdl from './assets/actions/single_leg_rdl.gif';
import curl from './assets/actions/curl.gif';
import ab_wheel from './assets/actions/ab_wheel.gif';
import wide_goblet_squat from './assets/actions/wide_goblet_squat.gif';
import sumo_squat from './assets/actions/sumo_squat.gif';
import hip_thrust from './assets/actions/hip_thrust.gif';
import incline_db_bench from './assets/actions/incline_db_bench.gif';
import db_pullover from './assets/actions/db_pullover.gif';
import triceps_ext from './assets/actions/triceps_ext.gif';
import weighted_plank from './assets/actions/weighted_plank.gif';

// key → { gif, tips: 中文要点[] }
// 备注：wide_goblet_squat 与 goblet_squat 形态相当共用指引；hip_thrust 取弹力带屈膝臀桥近似图
//      （居家足部不变，发力链一致）；db_bench 用坐/卧推形态近似凳上哑铃卧推
export const ACTION_GUIDES = {
  goblet_squat: {
    gif: goblet_squat,
    tips: [
      '双脚与肩同宽，哑铃竖抱于胸前，全程挺胸收腹',
      '臀部向后坐、屈膝下蹲，膝盖朝脚趾方向打开',
      '蹲至大腿与地面平行，底部稍停，脚跟发力蹬回'
    ]
  },
  db_bench: {
    gif: db_bench,
    tips: [
      '仰卧于凳，双手各握哑铃举于胸口上方，肩胛收紧',
      '下放时肘部约呈 45°，轻触到胸部即可',
      '胸肌发力向上推，顶端不完全锁死，控制回落'
    ]
  },
  db_row_bench: {
    gif: db_row_bench,
    tips: [
      '单膝撑凳、另一手扶凳，脊背保持平直，不塌腰',
      '哑铃沿身体侧面上拉至腰腹，肩胛主动后收',
      '下放时缓慢控制，顶部不耸肩，躯干不扭转'
    ]
  },
  rdl: {
    gif: rdl,
    tips: [
      '双手持哑铃于大腿前，膝微屈、脚掌踩实地面',
      '臀部向后送、背部始终平直，哑铃沿腿部下放',
      '下至大腿后侧有拉伸感即起，髋部发力顶回站直'
    ]
  },
  lateral_raise: {
    gif: lateral_raise,
    tips: [
      '双手持哑铃于体侧，肩放松，肘略屈',
      '向两侧平举至与肩同高，用三角肌带动而非甩',
      '顶端稍停后缓慢下放，避免身体晃动借力'
    ]
  },
  dead_bug: {
    gif: dead_bug,
    tips: [
      '仰卧，双臂上举、屈膝抬腿成 90°，腰背贴地',
      '对侧手脚同时缓慢下放，下背不悬空',
      '呼气下降、吸气回到起始，腹部始终收紧'
    ]
  },
  bulgarian_split_squat: {
    gif: bulgarian_split_squat,
    tips: [
      '前脚站稳，后脚背搭在凳/椅上，躯干直立',
      '垂直下蹲，前膝朝脚尖方向、重心压前脚掌',
      '下至前腿约 90°，顶端收紧臀腿再换侧'
    ]
  },
  half_kneel_press: {
    gif: half_kneel_press,
    tips: [
      '单膝跪地、另一腿在前呈 90°，躯干收紧不后仰',
      '对侧手持哑铃垂直向上推举，稳定核心',
      '顶端短暂停留，缓慢下放回到耳旁再重复'
    ]
  },
  bent_over_row: {
    gif: bent_over_row,
    tips: [
      '俯身至躯干近水平，背平、膝微屈，哑铃垂于身前',
      '把哑铃拉向腰腹，肘贴身、肩胛后收',
      '顶部感受背部挤压，缓慢下放至臂伸直'
    ]
  },
  single_leg_rdl: {
    gif: single_leg_rdl,
    tips: [
      '单腿站立微屈膝，另一腿向后伸保持平衡',
      '髋部前折、背部平直，哑铃沿站立腿下放',
      '后腿与躯干成一线，底部有拉伸感即顶臀回正'
    ]
  },
  curl: {
    gif: curl,
    tips: [
      '双手持哑铃于体侧，肘贴住躯干不外移',
      '肱二头肌发力弯举哑铃至肩前，动作平稳',
      '顶部稍停，缓慢下放至臂近乎伸直'
    ]
  },
  ab_wheel: {
    gif: ab_wheel,
    tips: [
      '跪姿握稳滚轮，核心收紧、不塌腰',
      '缓慢前滚至躯干接近地面水平',
      '腹肌发力拉回，全程控制速度避免腰部代偿'
    ]
  },
  wide_goblet_squat: {
    gif: wide_goblet_squat,
    tips: [
      '双脚略宽于肩外展，哑铃竖抱胸前',
      '臀部向后下蹲，膝盖朝脚尖方向打开',
      '蹲至大腿平行地面，脚掌发力蹬回'
    ]
  },
  sumo_squat: {
    gif: sumo_squat,
    tips: [
      '双脚宽于肩、脚尖外展，持铃于腿间或胸前',
      '臀部后坐下蹲，膝朝脚尖方向打开',
      '下至大腿平行，脚跟蹬地、收紧臀部回正'
    ]
  },
  hip_thrust: {
    gif: hip_thrust,
    tips: [
      '上背靠凳/沙发，哑铃置于髋部，双脚踩实',
      '臀部发力顶起至躯干与大腿成一线，不塌腰',
      '顶部收紧臀部稍停，缓慢下放再重复'
    ]
  },
  incline_db_bench: {
    gif: incline_db_bench,
    tips: [
      '凳背调至 30–45°，仰卧双手握铃于胸上方',
      '双铃下放至胸侧，肘部约 45° 不外扩',
      '胸肌上部发力上推，顶端稍停控制回落'
    ]
  },
  db_pullover: {
    gif: db_pullover,
    tips: [
      '仰卧，双手托单只哑铃于胸上方，肘微屈',
      '向头后缓慢下放哑铃，保持肘部角度不变',
      '背部/胸发力将哑铃拉回胸前，全程控制'
    ]
  },
  triceps_ext: {
    gif: triceps_ext,
    tips: [
      '双手持铃于头后上方，肘部向前收拢内夹',
      '前臂缓慢下放哑铃至脑后偏深',
      '三头肌发力伸直手臂回到原位，肘不锁死'
    ]
  },
  weighted_plank: {
    gif: weighted_plank,
    tips: [
      '前臂撑地，身体从头到脚呈一条直线，腹收紧',
      '在背上加负重片/哑铃增加刺激，不塌腰不撅臀',
      '静态保持，均匀呼吸，颈部保持中立'
    ]
  }
};