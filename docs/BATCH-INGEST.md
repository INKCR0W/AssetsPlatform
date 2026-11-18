# 批量入库

在启用入库的目录打开「批量入库」，输入有权限的项目令牌。可一次选多个 GLB、PNG 或 JPG，也可选择文件夹。界面按文件名和相对目录给出归属，明确匹配的空字段会自动填写。用「待确认」检查剩余条目，或者点「匹配归属」重新匹配。已有选择会保留。预览后先校验，再入库。

从「草稿箱」可以找回自己的草稿和交给自己的批次。删除错传的贴图或动画会一并移除它的关联。删除模型会移除对应版本，其附件仍可重新分配。删除后需要重新校验。废弃的未发布草稿可以整批丢弃。

整理好的草稿可以指派给同一项目中有发布权限的人。对方用自己的令牌打开草稿箱，检查预览、修改归属、重新校验并入库，也可以退回。交接期间创建者可以查看草稿或撤回交接。

从已有模型的详情点「追加版本」，上传 GLB 及附件后填写新版本名。草稿可保存和交接，发布后新版本出现在原模型下。已有版本的投票、评论和选配仍按原版本查找。同一模型下的版本名应能区分，若其他批次先发布了同名版本，请换个版本名再校验。

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
      "id":"asset-agent",
      "tokenHash":"<agent token SHA-256>",
      "permissions":["ingest:write"],
      "projects":["my-models"]
    },
    {
      "id":"asset-publisher",
      "tokenHash":"<publisher token SHA-256>",
      "permissions":["ingest:publish"],
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

浏览器和本地 agent 都以 `Authorization: Bearer <token>` 访问。只负责整理并移交的 agent 可只授予 `ingest:write`。接收人拥有 `ingest:publish` 时，对指派给自己的草稿可以编辑、校验和发布。要创建自己的草稿还需要 `ingest:write`。入库服务与目录在同一个 Node 服务上，访问范围跟随该目录的部署入口。

一个状态目录由一个 Node 进程写入。每批最多 48 个文件、192 MiB、20 个模型版本和 80 个附件关联。达到版本或关联上限时，网页会保留超出的暂存文件。服务最多保留 256 个批次和 2 GiB 文件。草稿与发布记录在服务重启后保留。丢弃草稿或移除文件时，系统只回收已无草稿或发布记录引用的文件。

## API

以 `/api/v1/ingest-batches` 为集合地址。带 `/{id}` 的请求将对应路径接到集合地址后面。

| 请求 | 内容 |
|---|---|
| `GET /api/v1/ingest-batches` | 查询参数 `projectId` 和 `datasetId`，返回 `limits`、创建权限 `permissions.create`、可接收人 `recipients` 和可访问草稿 `batches`。传入 `targetObjectId` 时查找同目录下的模型并返回 `target` |
| `POST /api/v1/ingest-batches` | `{ "projectId": "...", "datasetId": "..." }`，返回批次标识、修订号、`limits` 和 `access`。追加版本时一并传入 `targetObjectId` |
| `PUT /{id}/files/{fileId}` | 原始字节，`Content-Type: application/octet-stream`，`X-File-Name` 和可选的 `X-Relative-Path` 使用 `encodeURIComponent` 编码 |
| `GET /{id}` | 读取草稿、暂存文件、修订号、`limits`、操作权限 `access` 和入库结果 |
| `GET /{id}/files/{fileId}/preview` | 读取暂存文件对应的预览 |
| `DELETE /{id}/files/{fileId}` | 移除暂存文件和关联项，返回 `revision` 和剩余的 `plan`，需要 `If-Match` |
| `DELETE /{id}` | 丢弃自己的未交接草稿，返回 `{}`，需要 `If-Match` |
| `PUT /{id}/plan` | 替换版本和绑定清单，需要 `If-Match` |
| `POST /{id}/suggest` | `{ "revision": 1, "plan": { ... } }`，返回归属建议；省略 `plan` 时使用已保存计划 |
| `POST /{id}/handoff` | `{ "revision": 1, "recipientId": "asset-publisher" }`，返回新修订号；使用 `null` 撤回或退回 |
| `POST /{id}/validate` | `{ "revision": 1 }`，返回校验标识和问题 |
| `POST /{id}/publish` | `{ "revision": 1, "validationId": "..." }`，另带 `Idempotency-Key` |

```json
{
  "versions": [
    {"id":"crate-standard","name":"运输箱","label":"标准版","modelFileId":"crate","source":"original","tags":["场景道具","木制"]}
  ],
  "bindings": [
    {"id":"new-wood","fileId":"wood","versionId":"crate-standard","kind":"texture","materialIndex":0},
    {"id":"sway-clip","fileId":"sway","versionId":"crate-standard","kind":"animation","clipIndex":0}
  ]
}
```

材质槽和动作索引来自文件上传响应。来源可填 `original`、`purchased`、`reference` 或 `other`。本地整理工具完成导出和分类之后，agent 按同样顺序上传文件和清单。校验问题带有 `code`、`severity` 和可定位的文件、版本或绑定标识。修订号过期时重新读取批次再改。重试同一发布请求沿用同一个幂等键。

上传者自己的 agent 可以在保存计划时为每个版本提交可选的 `tags`。每版最多提交 32 个标签，每个标签最长 32 个字符。服务会去掉首尾空白并忽略大小写去重，保留首次提交的写法。发布后，标签与来源标签一起用于模型目录的搜索和筛选。追加版本时也会把新标签带到原模型的目录卡片。

`X-Relative-Path` 是从所选目录开始、以文件名结尾的相对路径，仅作为匹配线索。返回的 `suggestions` 每条包含 `bindingId`、`status`、可直接填入空字段的 `fields` 和待确认的 `candidates`。状态为 `certain`、`review` 或 `unmatched`。调用该接口不保存计划。agent 可以合并 `fields`、处理候选，再按原流程保存和校验。

agent 保存计划后，从集合响应的 `recipients` 中选定接收人，用当前修订号调用 `handoff`。接收人的草稿列表将该批次标为 `relation: "incoming"`，创建者的列表标为 `"mine"`。交接、退回及移除文件都会使旧校验结果失效。修改计划或执行删除时，`If-Match` 使用带双引号的修订号，例如 `If-Match: "3"`。

追加版本的草稿在创建时绑定目标。使用草稿响应中的 `target` 核对模型标识与名称，计划只提交本批新增的版本和绑定。发布收据中的 `objectId` 是原模型标识，`id` 是新增的目录版本标识。客户端切换版本或计票时使用发布后的标识。
