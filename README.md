# 豆包助手

豆包（doubao.com）与 Dola（dola.com）页面增强工具，提供**生成素材无水印下载**与**豆包多账号管理**，v0.2.0 起新增**提示词库面板**。

> 本项目仅供学习和个人效率工具使用。账号数据只保存在本机浏览器，请自行妥善保管。

## 版本选择

| 功能 | v0.1.0 | v0.2.0 |
| :--- | :---: | :---: |
| 图片无水印下载 | 支持 | 支持 |
| 视频无水印下载 | 支持 | 支持 |
| 素材链接复制 | 支持 | 支持 |
| 多账号管理（保存 / 切换 / 改名 / 删除） | 支持 | 支持 |
| 提示词库面板 | 不支持 | 支持 |

**两个版本都支持图片和视频的无水印下载**，只是**下载入口的交互方式不同**，按使用习惯选择即可：

- 只需要素材下载 + 账号管理 → **v0.1.0**
- 还想用提示词库面板（一键写入）→ **v0.2.0**

## 界面截图

### v0.1.0

<img width="1920" height="953" alt="1" src="https://github.com/user-attachments/assets/0bc642ed-91a1-4877-8143-13acd5e8cfa0" />


### v0.2.0

<img width="1920" height="953" alt="2" src="https://github.com/user-attachments/assets/bab30090-3748-4599-8e06-2e9531e95130" />


## 功能特性

- **图片无水印下载**：提取生成图片的无水印原始地址并下载。
- **视频无水印下载**：解析并下载生成视频的无水印版本。
- **链接操作**：支持复制素材地址。
- **多账号管理**：保存、添加、切换、改名和删除多个豆包账号，账号快照保存在本机浏览器。
- **提示词库面板**（仅 v0.2.0）：内置提示词模板，可一键写入输入框。

## 支持范围

| 功能 | 豆包 doubao.com | Dola dola.com |
| :--- | :---: | :---: |
| 图片 / 视频无水印下载 | 支持 | 支持 |
| 素材链接复制 | 支持 | 支持 |
| 提示词库面板（v0.2.0） | 支持 | 支持 |
| 多账号管理 | 支持 | 支持 |

说明：

- **素材下载**：两个域名都支持，v0.1.0 与 v0.2.0 能力一致，差异只在入口的交互方式。
- **多账号管理**：v0.1.0 与 v0.2.0 **都支持**，但**仅在豆包站点生效**，Dola 站点不提供账号相关入口。
- 下载入口只会出现在页面**生成**的图片和视频上，用户自己上传的内容不会显示。

## 安装方法（Chrome / Edge 扩展）

本扩展未上架应用商店，需通过开发者模式加载。

1. 下载对应版本的源码包并解压（记住解压位置）：
   - v0.1.0：https://github.com/admin0x/doubaokit/archive/refs/tags/v0.1.0.zip
   - v0.2.0：https://github.com/admin0x/doubaokit/archive/refs/tags/v0.2.0.zip
2. 打开扩展管理页面：
   - Chrome：`chrome://extensions/`
   - Edge：`edge://extensions/`
3. 开启右上角的**开发者模式**。
4. 点击**加载已解压的扩展程序**。
5. 选择解压后**包含 `manifest.json` 的那一层文件夹**。
6. 打开 [豆包](https://www.doubao.com/chat/) 或 [Dola](https://www.dola.com/chat/) 的 Chat 页面开始使用，建议把「豆包助手」图标固定到工具栏。

> ⚠️ 浏览器是**引用**加载而不是复制：安装后不要删除或移动该文件夹，否则扩展会失效。

[![Star](https://img.shields.io/github/stars/admin0x/doubaokit?style=flat&label=Star&color=f5a623)](https://github.com/admin0x/doubaokit/stargazers)
[![Fork](https://img.shields.io/github/forks/admin0x/doubaokit?style=flat&label=Fork&color=6e56cf)](https://github.com/admin0x/doubaokit/forks)
[![访问量](https://komarev.com/ghpvc/?username=admin0x&label=访问量&color=0e75b6&style=flat)](https://github.com/admin0x/doubaokit)
[![Star History Chart](https://api.star-history.com/svg?repos=admin0x/doubaokit&type=Date)](https://star-history.com/#admin0x/doubaokit&Date)
