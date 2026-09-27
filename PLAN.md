# Orbit Web Config — 设计与实施记录

> 状态：**已实现并验证**。本文件记录需求、关键取舍和验证结果。

## Context

Orbit 是 Nyxuri / Noctalia 桌面环境里的「星环启动器」
（`~/.config/noctalia/tools/orbit-launcher.py`）：一个 GTK Layer-Shell 的
径向菜单，把应用、文件夹、网址排成星环，配一个搜索引擎轮盘。

它的配置全在 TOML 里，手改的痛点是：

- 图标是 Nerd Font 私有区字符（`󰞷`、`󰈺`），不知道该填哪个码点；
- 网址项用 `url`、命令项用 `cmd`、文件夹用 `children`，类型靠字段区分，容易写错；
- `color_key` 要对着动态调色板猜；
- 改完不知道会不会让 orbit 加载失败。

目标：在 `~/Projects/orbit-config` 下写一个本地 Web 应用，
用浏览器图形化地增删改查 orbit 的菜单项（尤其是 websites）与搜索引擎，
保存后写回 TOML。

## 关键事实（探索结论）

| 事实 | 位置 |
| --- | --- |
| 配置优先级：5 条路径，从高到低 | `orbit/config.py:CONFIG_PATHS` |
| 实际生效的是第 1 条 `orbit-items__custom__.toml`（dunder 协议，升级不覆盖） | 同上 |
| 读取逻辑：items 为空则回退 `DEFAULT_MENU_TREE`；引擎为空则回退 `DEFAULT_SEARCH_ENGINES` | `load_menu_tree()` / `load_search_config()` |
| 类型判定：`children` 优先 → 再 `url` → 再 `cmd` | `orbit/window.py:trigger_app` |
| 无守护进程，每次打开重新读配置 | `orbit-launcher.py` 每次 `load_menu_tree()` |
| `color_key` 取自 `~/.cache/nyxuri/palette.toml`，也可为 `#RRGGBB` | `orbit/palette.py` |
| 运行时会往 item 注入 `color` / `layout_*` / `*_w` / `*_h` / `center_angle` | `orbit/window.py:init_geometry` / `init_cached_layouts` |
| 环境只有 Python 3.14（有 `tomllib` 只读，无 flask/fastapi/toml）、node/npm | — |
| 系统装了 JetBrainsMono Nerd Font（v3，Material Design 图标在 U+F0001 以上） | `fc-list` |

## 方案（最终采用）

- **后端**：Python 3 标准库 `http.server`。零依赖，和 orbit 同语言，
  而且 `tomllib` 已经能读，只差一个写库。
- **前端**：原生 HTML/CSS/JS，无构建步骤，由后端直接托管。
- **写回**：`shutil.copy2` 备份 → 临时文件 + `os.replace` 原子替换 →
  立刻用 `tomllib` 读回验证，失败自动回滚。
- **写入目标**：只写 `CONFIG_PATHS[0]`，即 `orbit-items__custom__.toml`。
- **TOML 序列化**：手写确定性序列化器（字段顺序固定、可 diff），
  并清洗 orbit 运行时注入的字段。
- **图标库**：手写最小 TTF 解析器（`cmap` + `post` 表），从本机 Nerd Font
  提取 **真实的字形名 → 码点** 映射，再按分类精选 403 个。
- **预设**：内置「出厂默认」直接从 `orbit/config.py` 动态加载，
  所以 orbit 升级后这里的默认值自动跟随。
- **空文件夹**：写 `children = []` 占位，让「文件夹」类型能跨保存/重载存活。

## 为什么不用别的做法

| 备选 | 否决原因 |
| --- | --- |
| Flask / FastAPI + SQLite | 系统没装，且这活儿不需要框架；引依赖会破坏「零维护」 |
| Node/Express 后端 | 多一套运行时和依赖树，收益为零 |
| React/Vite 前端 | 需要构建步骤和 node_modules，改成单文件静态托管更省心 |
| 保留原文件注释的「原地 TOML 编辑」 | 需要完整 lossless TOML 解析器；且用户手改后偏移易错位。改为重新生成带中文注释头的整份文件，更好 diff |
| 写多种格式的配置文件 | 只写最高优先级那份，避免"改了不生效"的困惑 |

## 踩过的坑

1. **`post` 表 format 2.0 的偏移**：`glyphNameIndex` 里 `< 258` 指向 Mac 标准
   字形名，`>= 258` 才是自定义字符串数组（偏移 258）。一开始漏了这一步，
   得到的名字整体错位（把 `md-broom` 解析成了 `md-delete`）。
2. **Material Design 图标在补充平面**：`md-*` 码点在 `U+F0001` 以上，
   必须走 `cmap` format 12 子表，不能只看 format 4。
3. **空文件夹无法用 TOML 数组表表达**：零个 `[[items.children]]` 就是没有，
   于是改成写合法普通 key `children = []`，往返后类型不丢，orbit 也不受影响。
4. **前端保存时会带上内部状态**：用 `WeakMap` 存节点 uid / 类型，
   避免往 payload 里塞 `__uid`；后端 `sanitize_item` 再兜一层。

## 交付物

```
orbit-config.py                 命令行入口
orbitconfig/paths.py            路径与状态目录
orbitconfig/defaults.py         动态加载 orbit 出厂默认
orbitconfig/toml_io.py          TOML 序列化 + 运行时字段清洗
orbitconfig/store.py            读取/校验/写回/备份/预设/导入导出
orbitconfig/icons.py            图标库加载
orbitconfig/palette.py          Material You 调色板
orbitconfig/server.py           标准库 HTTP 服务 + REST API
orbitconfig/nerd_icons.json     403 个图标（由字体生成）
web/{index.html,style.css,app.js,favicon.svg}
tools/build_icons.py            从本机字体重新生成图标库（403 个）
tools/smoke_frontend.mjs        jsdom 前端冒烟测试（43 项断言）
tools/make_screenshots.mjs     生成 docs/ 界面截图
tools/install-user-integration.sh
packaging/{orbit-config.desktop,orbit-config.service,niri-keybind.snippet.kdl}
docs/screenshot-*.png          4 张界面截图
README.md
```

## 验证结果

| 验证项 | 结果 |
| --- | --- |
| TOML 往返（现有真实配置、嵌套三层 children、含引号/反斜杠/制表符） | ✅ 完全一致 |
| `render_document` 输出能被 `tomllib` 解析 | ✅ |
| 用 `orbit/config.py:load_menu_tree()` 读回写出的文件 | ✅ 4 顶级项 / 10 项 / 5 引擎 |
| 内联 id 重复、名称空、无 url/cmd/children、引擎重复 → 拒绝写入 | ✅ 文件 md5 未变 |
| 写前自动备份、恢复备份、恢复前再备份 | ✅ |
| 预设保存/载入/覆盖/重命名/删除、出厂默认（`__factory__`） | ✅ |
| 导出 JSON（带 Content-Disposition）、导入 JSON / items 数组 / TOML | ✅ |
| 伪造 `Host` / 跨站 `Origin` → 403 | ✅ |
| 静态资源目录穿越 → 404 | ✅ |
| 图标库全部来自本机字体（403 个，含 `md-web`=U+F059F 等已核对） | ✅ |
| jsdom 前端冒烟测试 55 项（启动、选中、改名、加子项、切换类型不丢数据、新增、删除确认、图标选择器、引擎增删、预设、备份、保存载荷、重载回归） | ✅ 全部通过 |
| 图标库布局回归保护（禁用 aspect-ratio / 固定格高 / 子元素 flex:none / 列宽 ≥ 84px） | ✅ 6 项断言 |
| 同一实例连跑两次（测试对已有状态免疫） | ✅ 全部通过 |
| `--token` 模式下：静态可访问、API 需令牌、错误令牌 401、前端功能正常 | ✅ |
| 全新环境（无配置文件）→ 展示出厂默认 → 保存后建文件 | ✅ |
| 只有低优先级文件（`scratchpad-items.json`）时可读取并提示会写到哪里 | ✅ |
| 4 张界面截图（内联真实调色板变量 + 真实渲染的 DOM） | ✅ |
| `node --check app.js`、`systemd-analyze verify`、`desktop-file-validate` | ✅ 无告警 |
| 真实 `orbit-items__custom__.toml` 在全部测试中未被改动 | ✅ mtime/md5 不变 |

## 评审反馈与修正（第二轮）

用户实际使用后，发现真实配置被改成了：`kitty` 从命令变成空文件夹（→ 在 orbit 里点它不再有任何反应），
`websites` 里的知乎换成了 DeepSeek。追查后确认：这三笔写入（20:57 / 20:59 / 21:02）是用户自己在浏览器里
点的保存，不是测试误伤 —— 原始文件完好地存在自动备份里（`...205748.web-edit.toml`，3821 字节）。

但这件事暴露了一个真实的 UX 陷阱：**把「命令 / 网址」切成「文件夹」时，旧字段是被静默删除的**
（只有反向切换才提示），于是很容易把 Kitty 这种启动项变成一个不干事的空文件夹。

修正：

1. **切换类型改为无损**：原类型的字段（`url` / `cmd` / `children`）先移入 `WeakMap` 暂存区，
   切回去自动恢复。不再需要“会丢弃数据”的恐怖确认框。
2. **“什么都干不了”的项主动报错**：新增 `isIncomplete()`，
   - 编辑区弹红色警示框（“这是个空文件夹，orbit 里点它不会有任何反应”）
   - 左侧树的类型徽标变红并加 `⚠`
   - 切换类型后如果目标类型还是空的，直接弹 toast 提醒
3. 新增 6 项回归断言，其中包含“命令 → 文件夹 → 命令”后 `cmd` 必须原样恢复。

## 评审反馈与修正（第一轮）

用户实际跑起来后提了两点，已修：

**1. 图标库太紧密，文字和图标重叠**

根因是 `.icon-cell` 用了 `aspect-ratio: 1`（格子高度被宽度锁定）+
子元素可被 flex 收缩：窄格子下内容比格子高，`justify-content: center`
把内容向上下两边挤出去，看起来就是图标和文字重叠。

修法：
- 去掉 `aspect-ratio`，改成固定 `height: 88px`
- `.ic-glyph` / `.ic-label` 都加 `flex: none`（不可收缩）+ 显式行高
- 列最小宽度 66px → 90px，间距 7px → 11px，内边距也放大
- 几何验算：内容 28 + 8 + 13 = 49px，可用 88 - 20 = 68px，余量 19px
- 并在冒烟测试里加了 6 项 CSS 断言，防止这个布局再被改回去

**2. 简化界面信息**

- 顶栏：“重新加载 / 导入 / 导出” 收成带悬浮提示的图标按钮；品牌去掉英文副标题
- 路径显示把 `$HOME` 缩写成 `~`，完整路径放悬浮提示；低优先级文件的提示文案也从两行缩到一行
- 编辑器：删掉了 7 段字段说明，改为标签 `title` 提示；只保留类型那一行说明
- 引擎卡片：去掉头部重复的名称（下面就是名称输入框），搜索地址提示收成 `title`，错误提示缩短
- 预览：删掉底部说明段；预设/备份：提示压到一行

截图重生成后，编辑器面板里的说明文字从 7 行降到 1 行。

## 后续可选

- 主题 / 布局参数（`BASE_ORBIT_RADIUS`、`DEADZONE_RADIUS` 等）目前不在 UI 内，
  因为它们写在 `orbit/config.py` 而不是配置 TOML 里（属于系统文件，改了升级会丢）。
- 若要支持多套「配置文件切换」而非「预设载入」，需要让 orbit 侧支持
  读取 `ORBIT_ITEMS_PATH` 之类的环境变量。
