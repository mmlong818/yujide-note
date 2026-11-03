# 鱼记得 note 🐟🔒

可网络同步的桌面便签，支持**便签内部分内容块加密**。基于 Tauri 2 + TypeScript。
（曾用名「大便签」，旧版数据在首次启动时自动迁移，无需手动处理）

- 单窗口列表式：左侧便签列表 + 右侧「大便利贴」编辑区
- 内容块加密：任意文本块可单独加密隐藏，全局一个主密码；点 🔒 上锁、点击卡片解锁、底部「全部上锁」一键锁好
- 删除保护：删除含加密内容的便签/块需要**重新输入主密码**；删除先进**垃圾桶**（侧栏入口），可恢复或彻底删除；**彻底删除会立即从本地与远端当前数据中移除内容**，只保留 30 天的轻量删除记录（仅 ID+时间戳）用于同步到其他设备
- 本地备份：每次保存自动滚动备份到本地（滚动 20 份 + 每日 1 份保留 7 天），见 `数据目录/backups/`
- 同步：数据同步到你自己的 **GitHub 私有仓库**（单文件 JSON），多台设备自动合并；换网络也能同步，无需自建服务器
- 安全：加密块在本地用 PBKDF2(310k) + AES-256-GCM 加密后才上传，**GitHub 上永远只有密文**；主密码不存储在任何地方

## 构建与运行

依赖：Node ≥ 20、pnpm、Rust（MSVC）+ tauri-cli 2。

```bash
pnpm install
pnpm tauri dev      # 开发模式运行
pnpm tauri build    # 产出安装包（NSIS）与 exe
pnpm test           # 单元测试（加密 / 合并 / 同步协议）
```

## 配置 GitHub 同步

1. 在 GitHub 创建 **fine-grained Personal Access Token**（github.com/settings/personal-access-tokens/new）：
   - Repository access：选你要用的仓库（或 All repositories）
   - Permissions：**Contents → Read and write**（想让它自动建仓库再给 Administration → Read and write）
2. 应用内点底部 ⚙️ 打开同步设置，填入 Token、Owner、仓库名（分支/路径留空用默认值）
3. 点「测试连接」——仓库不存在时会尝试自动创建私有仓库；失败则手动在 GitHub 建一个私有仓库再试
4. 点「保存并同步」。之后：启动自动拉取、改动 2 秒后自动推送、每 5 分钟轮询，状态栏可手动刷新

同一台机器多开无意义；在第二台设备上装应用并填**相同的 Token 与仓库**即可完成同步。

## 合并与冲突策略

按「便签」为粒度做 Last-Writer-Wins（updatedAt 新者胜），推送冲突（sha 变化）自动重拉合并再推。删除采用墓碑标记（垃圾桶内容各设备可见、可恢复）；**彻底删除**则立即从数据中移除内容，仅保留 30 天的删除记录（仅 ID+时间戳）传播到其他设备；垃圾桶超过 30 天自动清理。注意：GitHub 的历史提交中仍会保留旧版本内容（加密块在历史里只有密文，需主密码才能解开）；若需连历史一起清除，可在 GitHub 删除并重建同步仓库，再在应用里重新保存同步配置。

## 数据存放与隐私边界（请务必了解）

- 本机数据：`%APPDATA%/com.yujide.note/` 下的 `notes.json` 与 `settings.json`（状态栏 📁 可直接打开）。旧版 `com.dabianqian.desktop/` 的数据会在首次启动时自动复制过来，旧目录保留作为备份
- **本地备份**：`backups/` 子目录。每次保存内容有变化时自动备份旧数据（同一编辑会话 90 秒内合并为一份）；滚动备份保留 20 份，另有每日备份保留 7 天。恢复方法：关闭应用，把某份 `.bak` 复制覆盖 `notes.json` 再启动
- **垃圾桶**：删除的便签以墓碑形式同步到各设备，可在垃圾桶恢复；「彻底删除」立即移除内容（本地+远端），仅留 30 天删除记录用于传播删除
- **加密块**：本地加密后上传，远端只有密文（salt/iv/cipher），主密码与派生密钥不落盘
- **普通块**：以明文存放在私有仓库 JSON 中——依赖仓库私有性保护，请勿把 Token 给予第三方
- **Token**：明文保存在本机 `settings.json`（应用数据目录受 Windows 用户隔离保护），不要提交到任何仓库
- 忘记主密码 = 对应加密内容永久无法解开（这是特性不是 bug）

## 目录结构

```
src/            前端 TypeScript
  crypto.ts     PBKDF2 + HKDF + AES-GCM，会话密钥缓存
  merge.ts      便签级 LWW 合并 + 墓碑
  sync.ts       GitHub Contents API 客户端
  engine.ts     同步编排（防抖推送 / 轮询 / 冲突处理）
  state.ts      状态中心与持久化
  ui/           界面（vanilla TS，无框架）
src-tauri/      Rust 侧：仅 3 个命令（JSON 原子读写 / 打开数据目录）
tests/          vitest 单测（merge / crypto / sync）
scripts/gen-icons.mjs  生成应用图标（纯 Node，无依赖）
```
