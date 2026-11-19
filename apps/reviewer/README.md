# 独立资产审阅器

这是 AssetsPlatform 的静态本地入口；项目自有代码使用 MIT。无需账号或 npm 依赖。

在此目录运行 `npm start`，打开 http://127.0.0.1:8768/。Node 服务提供批量入库和 [Agent 接入说明](agent.md)，只监听本机。需要静态浏览入口时也可运行 `python3 serve.py`。`npm test` 需要 Node.js 和 Python 3，会运行文件、目录身份、资源预算与服务器回归。

详细操作见 [产品手册](../../docs/PRODUCT-MANUAL.md)，接入规则见 [数据契约](../../docs/DATA-CONTRACT.md)。当前 v2 备份严格绑定项目与数据集，v1 迁移需要明确确认。审阅 JSON 不包含模型文件。

两个示例均为自制立方体。模型预览需要 WebGL；本轮未完成真实 GPU 或真人操作复验，不宣称原游戏 Shader 一致性。托管服务不属于此静态程序。
