# 批量入库

在启用入库的目录打开「批量入库」，输入有权限的项目令牌。可一次选多个 GLB、PNG 或 JPG，也可选择文件夹。界面按文件名和相对目录给出归属，明确匹配的空字段会自动填写。用「待确认」检查剩余条目，或者点「匹配归属」重新匹配。已有选择会保留。预览后先校验，再入库。

模型和动画使用自包含 GLB。贴图绑定到材质槽的底色通道。入库保留原始文件，网页使用轻量预览，选配导出读取原件。批量入库的 Node 服务需要 Python 3 和 Pillow（9.1+）解码图片与 GLB 内嵌贴图。安装步骤见[本地目录导入](LOCAL-DIRECTORY-IMPORT.md)。

## 启动

准备一个[本地目录工作区](LOCAL-DIRECTORY-IMPORT.md)。入库状态目录和配置文件都放在工作区之外。创建配置文件，把下列项目及数据集 ID 换成工作区 `library/project-config.json` 中的值。默认导入目录对应 `/library/`。

```json
{
  "stateDir": "./ingest-data",
  "projects": [
    {"projectId":"my-models","datasetId":"glb-…","assetRoot":"/library/"}
  ],
  "users": [
    {
      "id":"artist",
      "tokenHash":"<SHA-256 lowercase hex>",
      "permissions":["ingest:write","ingest:publish"],
      "projects":["my-models"]
    }
  ]
}
```

令牌和哈希的生成方式见[团队配置](TEAM-WORKBENCH.md)。把配置路径传给工作区的 Node 服务。

```powershell
$env:ASSETS_INGEST_CONFIG = 'D:/private-assets/ingest.json'
node server.mjs
```

浏览器和本地 agent 都以 `Authorization: Bearer <token>` 访问。只需要替人整理和验证的 agent 可只授予 `ingest:write`。需要发布的账号同时领取 `ingest:publish`。入库服务与目录在同一个 Node 服务上，访问范围跟随该目录的部署入口。

一个状态目录由一个 Node 进程写入。每批最多 48 个文件、192 MiB、20 个模型版本和 80 个附件关联。达到版本或关联上限时，网页会保留超出的暂存文件。服务最多保留 256 个批次和 2 GiB 文件。草稿与发布记录在服务重启后保留，当前版本不会自动清理旧草稿。

## API

以 `/api/v1/ingest-batches` 为集合地址。带 `/{id}` 的请求将对应路径接到集合地址后面。

| 请求 | 内容 |
|---|---|
| `GET /api/v1/ingest-batches` | 查询参数 `projectId` 和 `datasetId`，检查权限并返回 `limits` |
| `POST /api/v1/ingest-batches` | `{ "projectId": "...", "datasetId": "..." }`，返回批次标识、修订号和 `limits` |
| `PUT /{id}/files/{fileId}` | 原始字节，`Content-Type: application/octet-stream`，`X-File-Name` 和可选的 `X-Relative-Path` 使用 `encodeURIComponent` 编码 |
| `GET /{id}` | 读取批次、暂存文件、修订号、`limits` 和入库结果 |
| `GET /{id}/files/{fileId}/preview` | 读取暂存文件对应的预览 |
| `PUT /{id}/plan` | 替换版本和绑定清单，`If-Match` 为当前修订号 |
| `POST /{id}/suggest` | `{ "revision": 1, "plan": { ... } }`，返回归属建议；省略 `plan` 时使用已保存计划 |
| `POST /{id}/validate` | `{ "revision": 1 }`，返回校验标识和问题 |
| `POST /{id}/publish` | `{ "revision": 1, "validationId": "..." }`，另带 `Idempotency-Key` |

```json
{
  "versions": [
    {"id":"crate-standard","name":"运输箱","label":"标准版","modelFileId":"crate","source":"original"}
  ],
  "bindings": [
    {"id":"new-wood","fileId":"wood","versionId":"crate-standard","kind":"texture","materialIndex":0},
    {"id":"sway-clip","fileId":"sway","versionId":"crate-standard","kind":"animation","clipIndex":0}
  ]
}
```

材质槽和动作索引来自文件上传响应。来源可填 `original`、`purchased`、`reference` 或 `other`。本地整理工具完成导出和分类之后，agent 按同样顺序上传文件和清单。校验问题带有 `code`、`severity` 和可定位的文件、版本或绑定标识。修订号过期时重新读取批次再改。重试同一发布请求沿用同一个幂等键。

`X-Relative-Path` 是从所选目录开始、以文件名结尾的相对路径，仅作为匹配线索。返回的 `suggestions` 每条包含 `bindingId`、`status`、可直接填入空字段的 `fields` 和待确认的 `candidates`。状态为 `certain`、`review` 或 `unmatched`。调用该接口不保存计划。agent 可以合并 `fields`、处理候选，再按原流程保存和校验。
