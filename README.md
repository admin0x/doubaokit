<div align="center">

# 豆包助手 · DoubaoKit

豆包（doubao.com）与 Dola（dola.com）页面增强扩展
**无水印素材下载 · Seedance 时长增强 · 多账号管理 · 提示词库一键调用**

[![Version](https://img.shields.io/badge/version-v0.3.0-2ea44f?style=flat-square)](https://github.com/admin0x/doubaokit/releases)
[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge-4285f4?style=flat-square)](https://github.com/admin0x/doubaokit)
[![Star](https://img.shields.io/github/stars/admin0x/doubaokit?style=flat-square&label=Star&color=f5a623)](https://github.com/admin0x/doubaokit/stargazers)
[![Fork](https://img.shields.io/github/forks/admin0x/doubaokit?style=flat-square&label=Fork&color=6e56cf)](https://github.com/admin0x/doubaokit/forks)
[![Visits](https://komarev.com/ghpvc/?username=admin0x&label=访问量&color=0e75b6&style=flat-square)](https://github.com/admin0x/doubaokit)

</div>

> **免责声明**：本项目仅供学习交流与个人效率提升使用。账号数据仅保存在本机浏览器，请自行妥善保管，请勿用于任何违反平台服务条款或法律法规的用途。

---

## 目录

- [功能特性](#功能特性)
- [支持范围](#支持范围)
- [界面预览](#界面预览)
- [安装方法](#安装方法)
- [使用说明](#使用说明)
- [常见问题](#常见问题)
- [Star History](#star-history)

---

## 功能特性

| 功能 | 说明 |
| :--- | :--- |
| 🖼️ 图片无水印下载 | 提取生成图片的无水印原始地址并直接下载 |
| 🎬 视频无水印下载 | 解析并下载生成视频的无水印版本 |
| ⏱️ Seedance 15s / 30s 增强 | 扩展 Seedance 视频生成时长选项，支持 15 秒 / 30 秒输出 |
| 🔗 素材链接复制 | 一键复制素材原始地址，便于二次分发 |
| 👥 多账号管理 | 支持保存、切换、改名、删除多个豆包账号，快照存于本机浏览器 |
| 📚 提示词库面板 | 内置提示词模板，一键写入输入框，数据可自由管理 |

---

## 支持范围

| 功能 | 豆包 doubao.com | Dola dola.com |
| :--- | :---: | :---: |
| 图片 / 视频无水印下载 | ✅ | ✅ |
| Seedance 15s / 30s 增强 | ✅ | ✅ |
| 素材链接复制 | ✅ | ✅ |
| 多账号管理 | ✅ | ✅ |
| 提示词库面板 | ✅ | ✅ |

**补充说明**

- **素材下载**：两个域名均支持，位于视频/图片右下角位置。
- **入口范围**：下载入口只出现在页面**生成**的图片和视频上，用户自行上传的内容不会显示。
- **时长增强**：依赖页面当前开放的 Seedance 生成能力，站点侧未开放对应时长时选项不生效。

---

## 界面预览

### 主界面

![](https://github.com/user-attachments/assets/bab30090-3748-4599-8e06-2e9531e95130)

### 多账号管理

<div align="center">
  <img width="250" src="https://github.com/user-attachments/assets/27f9b61d-2d6b-4fce-abbe-8833a0e82040" alt="多账号管理-1" />
  <img width="250" src="https://github.com/user-attachments/assets/aa12cd1c-1400-4892-a56a-73679b51f496" alt="多账号管理-2" />
</div>

---

## 安装方法

本扩展未上架应用商店，需通过**开发者模式**加载（Chrome / Edge 通用）。

### 1. 下载源码包

| 版本 | 下载地址 |
| :--- | :--- |
| v0.3.0 | https://github.com/admin0x/doubaokit/archive/refs/tags/v0.3.0.zip |

下载后解压到本地，**记住解压位置**。

### 2. 加载扩展

1. 打开扩展管理页面：
   - Chrome：`chrome://extensions/`
   - Edge：`edge://extensions/`
2. 开启右上角的 **开发者模式**。
3. 点击 **加载已解压的扩展程序**。
4. 选择解压后 **包含 `manifest.json` 的那一层文件夹**。
5. 打开 [豆包](https://www.doubao.com/chat/) 或 [Dola](https://www.dola.com/chat/) 的 Chat 页面即可使用。

> 💡 建议将「豆包助手」图标**固定到工具栏**，方便随时打开面板。

> ⚠️ 浏览器采用**引用方式**加载扩展（不会复制文件）：安装后请勿删除或移动该文件夹，否则扩展会失效。

---

## 使用说明

1. **下载素材**：在 Chat 页面生成的图片或视频上，点击扩展注入的下载按钮，即可保存无水印版本；也可一键复制素材链接。
2. **Seedance 时长增强**：在视频生成处选择 15s / 30s 时长选项，按增强后的参数发起生成。
3. **管理账号**：点击工具栏图标打开面板，可保存当前登录账号、在多个账号间快速切换，并为账号改名或删除。
4. **调用提示词**：在提示词库面板中选择模板，一键写入输入框，模板内容支持自由增删改。

---

## 常见问题

<details>
<summary><b>为什么部分图片 / 视频没有下载入口？</b></summary>

下载入口只对页面**生成**的图片与视频生效，用户自行上传的内容不会出现入口，属正常行为。

</details>

<details>
<summary><b>Seedance 15s / 30s 选项没有出现？</b></summary>

时长增强依赖页面当前开放的生成能力，站点侧未开放对应时长时选项不会出现；请确认已进入支持 Seedance 的生成页面。

</details>

<details>
<summary><b>安装后扩展失效或报错怎么办？</b></summary>

扩展以引用方式加载，请确认解压文件夹未被删除、移动或重命名；若路径已变动，重新加载一次即可。

</details>

<details>
<summary><b>更换电脑或清理浏览器数据后账号丢失？</b></summary>

账号快照仅保存在本机浏览器中，清理站点数据、重装浏览器或更换设备都会导致数据丢失，请提前做好备份。

</details>

<details>
<summary><b>可以和旧版本同时安装吗？</b></summary>

不建议。各版本功能重叠，同时启用可能造成页面入口重复，请保留其一。

</details>

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=admin0x/doubaokit&type=Date)](https://star-history.com/#admin0x/doubaokit&Date)

---

<div align="center">

如果这个项目对你有帮助，欢迎点个 ⭐ Star 支持一下。

</div>
