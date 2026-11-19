# AssetsPlatform 本机入库 API

Node 服务默认地址为 `http://127.0.0.1:8768`。从当前站点读取本页并使用同一个地址发请求。接口无需登录。本机浏览器和 agent 看到同一份草稿。静态预览和 Python 服务只提供浏览入口。

所有请求路径都以 `/api/v1/ingest-batches` 开头。下文的 `/{id}` 指此前返回的 `batchId`。

```sh
curl http://127.0.0.1:8768/api/v1/ingest-batches
```

| 操作 | 请求 |
| --- | --- |
| 查可入库目录 | 对集合地址发送 GET，返回 `projects`，每项包含 `projectId`、`datasetId` |
| 找草稿 | 对集合地址发送 GET，查询参数为 `projectId`、`datasetId`，返回 `limits` 和 `batches` |
| 新建草稿 | 对集合地址发送 POST，JSON 为 `{"projectId":"…","datasetId":"…"}` |
| 上传一个文件 | `PUT /{id}/files/{fileId}`，原始字节，使用下方文件头 |
| 查看草稿 | `GET /{id}`，返回 `revision`、`files`、`plan` 和当前校验状态 |
| 获取匹配建议 | `POST /{id}/suggest`，JSON 为 `{"revision":1,"plan":{…}}`，可省略 `plan` 使用保存过的计划 |
| 保存入库计划 | `PUT /{id}/plan`，JSON 为下方计划，带 `If-Match` |
| 校验 | `POST /{id}/validate`，JSON 为 `{"revision":1}`，返回 `validationId` 与 `issues` |
| 发布 | `POST /{id}/publish`，JSON 为 `{"revision":1,"validationId":"…"}`，带 `Idempotency-Key` |
| 移除文件或丢弃草稿 | `DELETE /{id}/files/{fileId}` 或 `DELETE /{id}`，带 `If-Match` |

上传时用 `Content-Type: application/octet-stream`，`X-File-Name` 填经过 `encodeURIComponent` 的文件名。可选的 `X-Relative-Path` 同样编码，从所选目录起算，末尾必须是文件名。模型和动作使用自包含 GLB，外置底色贴图使用 PNG 或 JPG。每个上传自选稳定的文件 ID，例如 `box-model`，重传同一文件沿用其 ID。

保存计划示例

```json
{
  "versions": [
    {"id":"standard","name":"木箱","label":"标准版","modelFileId":"box-model","tags":["道具","木制"]}
  ],
  "bindings": [
    {"id":"wood-slot","fileId":"wood-image","versionId":"standard","kind":"texture","materialIndex":0},
    {"id":"open-motion","fileId":"open-glb","versionId":"standard","kind":"animation","clipIndex":0}
  ]
}
```

- 从上传响应确认材质槽和动画索引。标签由调用方填写，每版最多 32 个，每个最长 32 个字符。
- JSON 请求使用 `Content-Type: application/json`。保存计划或删除时的 `If-Match` 使用带双引号的修订号，例如 `"1"`。遇到 `STALE_REVISION` 时先读取草稿。建议接口的 `fields` 用来填空，`candidates` 可交给人确认。
- 追加到已有模型时，在新建草稿的 JSON 中再传 `targetObjectId`。目标模型 ID 可从项目资产根的 `assets/objects-catalog.json` 或 `assets/ingested/index.json` 查到。
- 校验有 `error` 时处理完再发布。若要留给人确认，保存草稿并给对方发网页链接 `/ingest.html?project=<projectId>&dataset=<datasetId>&batch=<batchId>`。重试相同发布请求时沿用原来的 `Idempotency-Key`。
