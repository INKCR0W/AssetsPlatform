# 团队资产工作台

模型目录显示登记了 GLB 的完整物件。模型的贴图、材质、动画和其他资料在详情里查看。打开「配置、投票与下载」，可以对当前版本投票或留言，也可以为物件添加可搜索、可筛选的标签。

选择模型版本、可替换的底色贴图和要带走的动作，预览完成后加入「待下载清单」。同一个模型可以用不同配置加入多次。清单内可以修改或移除条目，再统一下载。每条配置单独分目录，其中的 GLB 内嵌模型、标准材质、贴图和已选动画。根清单记录配置与文件的对应关系。[在 Unity 中使用下载包](UNITY-ASSET-IMPORT.md)

## 本机模式和团队模式

普通静态部署或无配置的 Node 服务使用本机模式，投票、留言和标签存在当前浏览器。待下载清单在当前页面中维护，先下载再切换项目或刷新。

团队模式使用同一个 Node 服务。管理员在静态目录之外准备一份 JSON 配置和状态文件目录。每位用户有独立随机令牌，配置只写令牌哈希。可用 Node 生成一组令牌和哈希：

```sh
node -e "const c=require('node:crypto');const t=c.randomBytes(32).toString('base64url');console.log(t);console.log(c.createHash('sha256').update(t).digest('hex'))"
```

配置示例，替换哈希占位并按需添加用户和目录：

```json
{
  "stateFile": "./workbench-state.json",
  "projects": [{"projectId":"demo-a","datasetId":"example-v1"}],
  "users": [
    {"id":"reviewer-a","name":"成员 A","tokenHash":"<SHA-256 小写十六进制>"},
    {"id":"reviewer-b","name":"成员 B","tokenHash":"<另一位成员的哈希>"}
  ]
}
```

以 PowerShell 启动：

```powershell
$env:ASSETS_TEAM_CONFIG = 'D:/private-workbench/team.json'
npm start
```

把每个明文令牌通过团队已授权的渠道分别交给对应用户。用户在工作台的团队入口输入令牌。服务端根据令牌决定用户身份，同一用户每个模型版本可投一票并可改投或撤回。不同模型版本分别计票，可单独留言。文件更新后使用新的版本 ID 或数据集 ID 来开启新一轮投票。标签作用于整个物件。投票当前只汇总意见，下载不由票数限制。

配置中的用户共享所列目录。对外访问需要受控 HTTPS 入口，Node 服务继续在本机监听。部署有访问控制要求的资产时，入口也应控制下载文件和目录本身的访问权限。团队配置和数据文件应由运维另行备份。
