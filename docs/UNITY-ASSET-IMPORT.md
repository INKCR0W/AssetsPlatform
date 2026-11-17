# 在 Unity 中使用下载的模型

下载的 ZIP 按模型配置分目录。同一个模型选择不同的版本、贴图或动画时，每种配置各占一个目录。目录名含模型内容摘要，修改配置后再次下载会导入到另一个目录，原有预制体和控制器可继续使用。目录里的 `.glb` 内嵌选定的网格、材质、贴图和动画。同目录的 `asset.json` 只记录模型路径、动画数量和用于匹配默认动作的名称摘要。根目录的 `manifest.json` 保存完整动画名称和默认动作名称。

1. 在目标工程的 Unity Package Manager 中按名称安装 `com.unity.cloud.gltfast`。Unity 2022.3.62f3 可使用 glTFast 6.14.1。若工程已配置其他 GLB 导入器，先确认 `.glb` 选中的导入器和团队约定一致。
2. 要自动生成带动画控制器的预制体，把 [Assets Platform 导入脚本](../scripts/unity/AssetsPlatformWorkbenchImporter.cs) 放入项目的 `Assets/Editor`。这一步每个目标工程只做一次。
3. 解压 ZIP，把需要使用的配置目录拖入 Unity **Project** 窗口的 **Assets**。保留同目录的 `asset.json`。安装导入脚本的工程会为配置生成 `*-Ready.prefab`。有动画的配置会生成控制器并接好导入的片段，进入播放模式时从默认状态开始。
4. 将 `*-Ready.prefab` 从 **Project** 拖入场景。只装 glTFast 的工程也可直接拖入 GLB 根资产，展开它可检查网格、材质、纹理和动画片段。材质使用 glTF 可表达的参数，Unity 项目专用 Shader、脚本和复杂状态机由目标工程配置。

参见 Unity 的 [Editor 导入说明](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.14/manual/ImportEditor.html) 和 [glTFast 功能表](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.14/manual/features.html)。

## 验证一个下载包

在仓库根目录运行以下 PowerShell 命令，替换示例路径：

```powershell
./scripts/verify-unity-import.ps1 `
  -Archive 'D:/Downloads/assets-workbench.zip' `
  -UnityEditor 'C:/Program Files/Unity/Hub/Editor/2022.3.62f3/Editor/Unity.exe'
```

脚本使用隔离的临时 Unity 工程，不改目标工程。Unity 需完成授权，并且首次运行需要能从 Unity Registry 下载包。脚本会实例化每个模型，检查网格、材质和嵌入贴图绑定，并核对声明的动画是否已导入为含曲线的片段。对带配置标记的资产，脚本也会实例化生成的 Ready 预制体，核对 Animator 中的动画片段和默认动作。输出 `ASSET_IMPORT_PASS` 时表示这次批量验证通过。命令会打印临时工程路径，可在其中查阅 `Editor.log`。其他版本可用 `-UnityVersion` 和 `-GltfFastVersion` 指定。若系统盘空间不足，可用 `-ScratchRoot 'D:/'` 指定已有的临时目录。
