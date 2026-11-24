// 内嵌的两份 WebVTT 文本，内容与 review/master.vtt、review/notes.vtt 一致。
// 直接用 file:// 打开页面时 fetch 本地文件会被浏览器 CORS 拦截，因此内嵌；
// Node 测试会把这里的文本与磁盘上的真实文件逐字比对。

export const MASTER_VTT = `WEBVTT

不要出现
00:00:07.000 --> 00:00:07.800
不要出现

口型对齐
00:00:08.000 --> 00:00:09.520
口型对齐

第二段
00:00:10.000 --> 00:00:12.000
第二段

十一秒半
00:00:11.520 --> 00:00:12.000
十一秒半

出点之后
00:00:14.200 --> 00:00:15.000
出点之后
`;

export const NOTES_VTT = `WEBVTT

看这一口
00:00:00.000 --> 00:00:01.520
看这一口

闪一下
00:00:03.000 --> 00:00:03.120
闪一下

切片三点五
00:00:03.520 --> 00:00:04.000
切片三点五
`;

export const MASTER_TRACK_LABEL = '成片字幕';
export const NOTES_TRACK_LABEL = '审片批注';

export const MEDIA = {
  src: '../review/master.mp4',
  durationSec: 20.0,
  width: 320,
  height: 180,
  fps: 25
};
