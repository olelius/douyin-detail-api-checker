# run.bat 操作文档

本文档说明 `methods/node_detail_api/run.bat` 的作用、正式运行步骤、系统问题检查方法和常见错误处理。本文只覆盖 Node detail API 方案，不涉及旧 Python DOM 文本方案。

## run.bat 的作用

`run.bat` 是 Node detail API 方案的一键启动脚本。双击后会进入 `methods/node_detail_api` 目录，检查 Node.js 和 `node_modules`，执行语法检查，然后启动本地 Web UI 服务：

```bat
cmd /c npm start
```

当前 `run.bat` 已从直接运行 CLI 检测调整为启动本地 Web UI 工作台。启动后访问：

```text
http://localhost:3000
```

CLI 仍然保留，命令为 `node src/main.js` 或 `cmd /c npm run start:cli`。

Web UI 启动命令本身不带 `--limit`；正式检测时也不要在 CLI 参数中使用 `--limit`，避免人为限制检测数量。

服务运行期间窗口会保持打开，用于承载本地 Web UI 服务和显示启动错误。检测、进度查看和结果导出都在浏览器工作台内操作；如果启动前检查失败，脚本会停在 `pause`，方便查看错误提示。

## 正式使用前准备

1. 安装 Node.js。建议使用 Node.js 22 或兼容版本，安装后在命令行执行 `node -v` 能看到版本号。
2. 安装系统 Chrome 或 Edge。程序优先调用系统浏览器，不强制安装 Playwright 自带浏览器。
3. 安装依赖。在 `methods\node_detail_api` 目录执行：

```bat
cmd /c npm install
```

4. 准备输入 Excel。默认输入查找顺序为：

```text
input\测试.xlsx
input\test.xlsx
..\python_playwright_dom_text\test.xlsx
```

正式使用建议把待检测文件放到：

```text
methods\node_detail_api\input\测试.xlsx
```

5. 关闭已打开的输出 Excel。如果 `output\检测结果.xlsx` 正被 Excel 打开，写入时可能失败。

## 推荐操作步骤

### 方式一：双击 run.bat

1. 打开目录 `methods\node_detail_api`。
2. 双击 `run.bat`。
3. 等待窗口显示本地 Web UI 服务已启动。
4. 在浏览器访问：

```text
http://localhost:3000
```

5. 在 Web UI 内选择 Excel、启动检测、查看进度，并从页面导出检测结果。

### 方式二：命令行运行

在 PowerShell 或 CMD 中执行：

```bat
cd /d D:\hongye\douyin_url\methods\node_detail_api
node src\main.js
```

也可以显式指定输入和输出：

```bat
node src\main.js input\测试.xlsx output\检测结果.xlsx
```

正式检测不要带 `--limit`。`--limit` 只用于小批量测试验证，例如只想先跑前 3 条确认流程是否正常。

## Web UI 与 CLI 入口

- Web UI：双击 `methods/node_detail_api/run.bat`，或在本目录执行 `cmd /c npm start`，启动后访问 `http://localhost:3000`。
- CLI：继续保留 `node src/main.js` 和 `cmd /c npm run start:cli`。
- Web UI 第一阶段 HTTP detail API 快筛默认并发 `5`；第二阶段 Playwright 兜底默认并发 `2`，不稳定时降为 `1`。
- 默认开发、测试和验收不运行真实抖音网络检测；真实检测必须由用户明确要求。
- 全流程不使用 `networkidle`。
- 正式检测不要带 `--limit`；`--limit` 只用于小批量测试验证。

## 为什么之前有“跳过”

之前出现“跳过 1”不是系统漏检，而是验收命令人为加了 `--limit 3`：

```bat
node src\main.js ..\python_playwright_dom_text\test.xlsx output\检测结果.xlsx --limit 3 --concurrency 1 --delay 1000
```

该命令表示只检测前 3 条非空链接，第 4 条会按设计标记为：

```text
状态：跳过
备注：超过 --limit 限制未检测
```

正式运行 Web UI 或 CLI 时不要带 `--limit`，不会因为 limit 跳过。主线程曾验证 CLI 默认全量检测 4 条时，结果为存活 2、失效 2、待确认 0、跳过 0、失败 0。

## 系统问题检查清单

| 检查项 | 检查命令或方法 | 正常表现 |
|------|------|------|
| Node.js | `node -v` | 输出版本号 |
| npm 执行策略 | `cmd /c npm -v` | 输出 npm 版本号 |
| 依赖目录 | 查看 `methods\node_detail_api\node_modules` | 目录存在 |
| 依赖安装 | `cmd /c npm install` | 安装完成，无 fatal error |
| 语法检查 | `cmd /c npm run check` | 检查通过 |
| 系统浏览器 | 打开 Chrome 或 Edge | 浏览器可正常启动 |
| 输入文件 | 查看 `input\测试.xlsx` 或 `input\test.xlsx` | 文件存在，含抖音链接列 |
| 输出权限 | 确认 `output\检测结果.xlsx` 未被 Excel 打开 | 程序可写入 |
| 网络和风控 | 小批量检测观察状态 | 无登录、验证码、安全验证、访问频繁等页面 |
| 中文路径和编码 | 保持当前目录中文可读，文档 UTF-8 无 BOM | 控制台和 Excel 中文正常 |

PowerShell 直接运行 `npm` 如果被执行策略拦截，优先使用 `cmd /c npm ...`。

## 常见错误和解决办法

### 未检测到 Node.js

现象：`run.bat` 提示“未检测到 Node.js”。

处理：

1. 安装 Node.js 22 或兼容版本。
2. 重新打开 PowerShell 或 CMD。
3. 执行 `node -v` 确认可用。

### node_modules 不存在

现象：`run.bat` 提示“未检测到依赖目录 node_modules”。

处理：

```bat
cd /d D:\hongye\douyin_url\methods\node_detail_api
cmd /c npm install
```

安装完成后再双击 `run.bat`。

### PowerShell npm 被禁

现象：PowerShell 执行 `npm install` 报脚本执行策略错误。

处理：使用 CMD 包装命令：

```bat
cmd /c npm install
cmd /c npm run check
cmd /c npm test
```

### 未找到输入 Excel

现象：程序提示找不到输入文件。

处理：

1. 把 Excel 放到 `methods\node_detail_api\input\测试.xlsx`。
2. 或命令行显式指定输入文件：

```bat
node src\main.js input\测试.xlsx output\检测结果.xlsx
```

### 页面待确认或疑似风控

现象：输出 `待确认`，备注含登录、验证码、安全验证、访问频繁等信息。

处理：

1. Web UI 中降低频率：API 快筛默认并发 `5`，Playwright 兜底默认并发 `2`；如结果不稳定或疑似触发风控，将 Playwright 兜底并发降为 `1`。
2. CLI 入口单独处理：CLI 默认并发 `1`，如需更保守可继续保持 `--concurrency 1` 并增大间隔，例如测试时使用 `--delay 2000`。
3. 等待一段时间后重试。
4. 不要把风控页面直接当作链接失效。

### 输出文件被 Excel 占用

现象：写入 `output\检测结果.xlsx` 失败，或提示权限/占用问题。

处理：

1. 关闭 Excel 中打开的 `检测结果.xlsx`。
2. Web UI 导出失败时，关闭占用文件后回到页面重新导出；CLI 检测失败时重新运行命令行。
3. 必要时改用新输出文件名：

```bat
node src\main.js input\测试.xlsx output\检测结果-新.xlsx
```

## 历史 CLI 阶段验证记录

以下内容是历史 CLI 阶段验证记录，不代表本轮 Web UI 最终验收。本轮 Task 9 仅更新文档，未启动 Web UI 服务，未执行真实抖音网络检测；Task 10 尚未完成。

历史 CLI 阶段曾验证默认全量命令：

```bat
node src\main.js
```

历史 CLI 阶段全量检测 4 条，汇总结果：

| 状态 | 数量 |
|------|------|
| 存活 | 2 |
| 失效 | 2 |
| 待确认 | 0 |
| 跳过 | 0 |
| 失败 | 0 |

历史 CLI 阶段输出文件：

```text
methods\node_detail_api\output\检测结果.xlsx
```

结论：正式运行 Web UI 使用 `run.bat` 或 `cmd /c npm start` 并访问 `http://localhost:3000`；CLI 使用 `node src\main.js` 或 `cmd /c npm run start:cli`。正式检测不要带 `--limit`；如果看到“超过 --limit 限制未检测”的跳过记录，说明当前命令带了 limit 参数。
