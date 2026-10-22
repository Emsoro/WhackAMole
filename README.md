# 打地鼠 · WhackaMole

> 版本：**v1.0.0**

一个用 **C++ 后端 + Web 前端** 写成的桌面打地鼠游戏：60 秒回合制，地鼠从 8 个木桩洞口冒头，
点中得分、连击涨倍率；金地鼠 +500 送道具，戴安全帽的要敲两下，**炸弹千万别碰**。

基于自研框架 [TauriCPP](https://github.com/Emsoro/TauriCPP)（C++ / Win32 / WebView2）：前端资源在编译期嵌入 exe，
运行时从内存加载，最终是单个可执行文件。

## 玩法

| 元素 | 说明 |
|---|---|
| 地鼠 | 普通地鼠 +100，四种颜色变体；随时间推移刷得越来越快 |
| 连击 | 2 秒内连续命中涨连击，倍率 `1 + combo/3`（封顶 x8）；点空清零 |
| 金地鼠 | +500 并随机送一个道具，停留时间更短 |
| 硬帽地鼠 | 安全帽要敲两下：第一下敲晕 +50，第二下 +250 |
| 炸弹 | 敲中 −300 并清空连击，不敲会自己缩回去 |
| 难度 | 简单 / 普通 / 困难：刷怪间隔、停留时长与炸弹概率不同 |

**道具**：`Freeze` 冰冻 5 秒（全场定住、暂停刷怪）· `Lightning` 闪电（立刻敲掉场上全部地鼠，炸弹被劈走不扣分）· `Magnet` 磁铁 8 秒疯狂刷怪。金地鼠会补充道具。

**操作**：`鼠标 / 触摸` 敲洞口 · `1-8` 敲对应洞口 · `Q/W/E` 用道具 · `P` 暂停 · `F12` DevTools

## 特性

- **C++ 游戏主循环**：后端 40ms tick 推进刷怪、状态机、倒计时与连击窗口，向前端推送全量状态快照
- **细腻前端渲染**：Canvas 程序化绘制草地/木桩洞/地鼠（冒头-缩回插值动画）、星星粒子、飘分、爆炸闪光、屏幕震动、冰冻雪花
- **程序化音频**：Web Audio 实时合成敲击/金鼠/铁帽/炸弹/倒计时/结算音效，并带一段柔和的 I–V–vi–IV 音乐盒循环背景乐（零音频文件），右上角按钮可一键静音
- **草地场景点缀**：多品种小花 + 手绘的猫、狗、蜗牛、蝴蝶，全部画在静态层，不增加每帧开销
- **数据持久**：各难度最佳成绩与声音开关存 localStorage
- **可测试**：游戏规则有 C++ 单元测试（`test/game_test.cpp`），覆盖刷怪/连击/道具/暂停/结束等 14 组场景
- **可调试**：支持 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`，用 CDP 截图、注入脚本

## 构建

环境要求：Windows 10/11 x64 · VS 2022（C++ 工作负载）· CMake 3.15+ · Python 3 · WebView2 静态 SDK（`vcpkg install webview2:x64-windows-static --classic`）

```powershell
.\build.ps1              # Release，前端资源嵌入 exe
.\build.ps1 -DevMode     # 开发模式：直接读 frontend/ 目录，改 UI 免重编
.\build.ps1 -Clean       # 清理重建
.\build.ps1 -Run         # 构建后立即启动
```

产物：`build\Release\WhackAMole.exe`（单文件无外部依赖）。

## 目录结构

```
WhackaMole/
├── src/                  # C++ 后端
│   ├── main.cpp          #   TauriCPP 入口、命令注册、游戏主循环线程
│   ├── game.hpp/.cpp     #   纯游戏逻辑（刷怪/命中/道具/计时，可单测）
│   └── app.ico           #   应用图标（由 icon.png 经 make_icon.py 生成）
├── frontend/             # Web 前端：Canvas 渲染 + Web Audio
│   ├── index.html
│   ├── css/style.css     #   木纹主题 UI
│   └── js/app.js         #   Bridge 通信、地鼠绘制、粒子、音效合成
├── test/game_test.cpp    # 游戏规则单元测试（ctest 可跑）
├── TauriCPP/             # 内置框架副本（C++/WebView2）
├── CMakeLists.txt
└── build.ps1
```

## 技术栈

`C++17` · `Win32` · `WebView2` · `nlohmann/json` · `Canvas 2D` · `Web Audio API` · `MSVC` · `CMake`

## 更新日志

- **v1.0.0**：首个公开版本。含三种难度、连击系统、金鼠/硬帽/炸弹、三种道具、程序化音效与背景音乐、草地装饰与静音开关。
