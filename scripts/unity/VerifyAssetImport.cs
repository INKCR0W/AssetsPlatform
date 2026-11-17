using System;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace AssetsPlatform.Tools
{
    public static class VerifyAssetImport
    {
        [Serializable]
        private sealed class GlbDeclaration
        {
            public NamedItem[] images;
            public NamedItem[] animations;
        }

        [Serializable]
        private sealed class NamedItem
        {
            public string name;
        }

        [Serializable]
        private sealed class Configuration
        {
            public string format;
            public string[] animations;
            public string defaultClipName;
        }

        public static void Run()
        {
            var paths = Directory.GetFiles("Assets/Imported", "*.glb", SearchOption.AllDirectories);
            if (paths.Length == 0)
                throw new InvalidDataException("No GLB files were staged for verification.");

            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene);
            foreach (var path in paths.OrderBy(path => path, StringComparer.Ordinal))
                Verify(path.Replace(Path.DirectorySeparatorChar, '/'));

            Debug.Log($"ASSET_IMPORT_PASS {paths.Length}");
        }

        private static void Verify(string path)
        {
            var declaration = ReadDeclaration(path);
            var imported = AssetDatabase.LoadMainAssetAtPath(path) as GameObject;
            if (imported == null)
                throw new InvalidDataException($"{path}: expected an imported GameObject. Check Unity glTFast installation.");

            var instance = PrefabUtility.InstantiatePrefab(imported) as GameObject;
            if (instance == null)
                throw new InvalidDataException($"{path}: imported GameObject could not be instantiated.");

            try
            {
                var regularMeshes = instance.GetComponentsInChildren<MeshFilter>(true).Select(filter => filter.sharedMesh);
                var skinnedMeshes = instance.GetComponentsInChildren<SkinnedMeshRenderer>(true).Select(renderer => renderer.sharedMesh);
                int meshes = regularMeshes.Concat(skinnedMeshes).Count(mesh => mesh != null && mesh.vertexCount > 0);
                if (meshes == 0)
                    throw new InvalidDataException($"{path}: imported prefab has no usable mesh.");

                var materials = instance.GetComponentsInChildren<Renderer>(true)
                    .SelectMany(renderer => renderer.sharedMaterials).Where(material => material != null).Distinct().ToArray();
                if (materials.Length == 0 || materials.Any(material => material.shader == null || material.shader.name == "Hidden/InternalErrorShader"))
                    throw new InvalidDataException($"{path}: imported prefab is missing usable materials or shaders.");

                int textures = materials.SelectMany(material => material.GetTexturePropertyNames().Select(property => material.GetTexture(property)))
                    .Where(texture => texture != null && AssetDatabase.GetAssetPath(texture) == path).Distinct().Count();
                if ((declaration.images?.Length ?? 0) > 0 && textures == 0)
                    throw new InvalidDataException($"{path}: GLB declares textures but imported materials have none assigned.");

                var clips = AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>()
                    .Where(clip => clip.length > 0 && (AnimationUtility.GetCurveBindings(clip).Length > 0 ||
                        AnimationUtility.GetObjectReferenceCurveBindings(clip).Length > 0)).ToArray();
                VerifyClips(declaration, clips, path);
                string ready = VerifyReadyPrefab(path, declaration, clips);
                Debug.Log($"ASSET_IMPORT_MODEL {path} meshes={meshes} materials={materials.Length} textures={textures} clips={clips.Length}{ready}");
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(instance);
            }
        }

        private static string VerifyReadyPrefab(string path, GlbDeclaration declaration, AnimationClip[] clips)
        {
            string configurationPath = Path.Combine(Path.GetDirectoryName(path), "asset.json");
            if (!File.Exists(configurationPath))
                return "";
            var config = JsonUtility.FromJson<Configuration>(File.ReadAllText(configurationPath));
            bool compact = config?.format == WorkbenchPrefabImporter.CompactConfigurationFormat;
            if (!compact && config?.format != WorkbenchPrefabImporter.LegacyConfigurationFormat)
                return "";

            string prefabPath = WorkbenchPrefabImporter.EnsurePrefab(path);
            if (string.IsNullOrEmpty(prefabPath))
                throw new InvalidDataException($"{path}: could not prepare the Ready prefab.");
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
            var instance = prefab == null ? null : PrefabUtility.InstantiatePrefab(prefab) as GameObject;
            if (instance == null)
                throw new InvalidDataException($"{path}: expected a generated Ready prefab.");

            try
            {
                var authored = declaration.animations ?? Array.Empty<NamedItem>();
                if (compact && clips.Length != authored.Length)
                    throw new InvalidDataException($"{path}: Ready prefab was generated with unexpected animation clips.");
                if (clips.Length == 0)
                {
                    if (compact && instance.GetComponentsInChildren<Animator>(true).Any(animator => animator.runtimeAnimatorController))
                        throw new InvalidDataException($"{path}: Ready prefab has a controller despite an empty animation set.");
                    return " readyPrefab=yes animatorClips=0";
                }
                var animator = instance.GetComponentInChildren<Animator>(true);
                var controller = animator?.runtimeAnimatorController as AnimatorController;
                if (controller == null || (compact && controller.animationClips.Length != authored.Length) ||
                    clips.Any(clip => !controller.animationClips.Contains(clip)))
                    throw new InvalidDataException($"{path}: Ready prefab Animator is missing imported clips.");

                string expectedDefault = compact ? authored[0].name : config.defaultClipName;
                if (!compact && string.IsNullOrEmpty(expectedDefault))
                    expectedDefault = (config.animations ?? Array.Empty<string>()).FirstOrDefault(
                        name => clips.Any(clip => clip.name == name));
                var defaultClip = controller.layers.FirstOrDefault()?.stateMachine.defaultState?.motion as AnimationClip;
                if (defaultClip == null || (expectedDefault != null && defaultClip.name != expectedDefault))
                    throw new InvalidDataException($"{path}: Ready prefab Animator has the wrong default clip.");

                return $" readyPrefab=yes animatorClips={controller.animationClips.Length}";
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(instance);
            }
        }

        private static void VerifyClips(GlbDeclaration declaration, AnimationClip[] clips, string path)
        {
            var expected = declaration.animations ?? Array.Empty<NamedItem>();
            if (clips.Length < expected.Length)
                throw new InvalidDataException($"{path}: expected {expected.Length} animation clips, imported {clips.Length}.");

            foreach (var item in expected.Where(item => !string.IsNullOrEmpty(item.name)))
            {
                if (!clips.Any(clip => clip.name == item.name))
                    throw new InvalidDataException($"{path}: animation clip was not imported: {item.name}");
            }
        }

        private static GlbDeclaration ReadDeclaration(string path)
        {
            using var stream = File.OpenRead(path);
            using var reader = new BinaryReader(stream);
            const uint glbMagic = 0x46546c67;
            const uint jsonChunk = 0x4e4f534a;
            if (reader.ReadUInt32() != glbMagic || reader.ReadUInt32() != 2 || reader.ReadUInt32() != stream.Length)
                throw new InvalidDataException($"{path}: invalid GLB header.");

            uint jsonBytes = reader.ReadUInt32();
            if (reader.ReadUInt32() != jsonChunk || jsonBytes == 0 || jsonBytes > stream.Length - stream.Position)
                throw new InvalidDataException($"{path}: invalid GLB JSON chunk.");

            return JsonUtility.FromJson<GlbDeclaration>(Encoding.UTF8.GetString(reader.ReadBytes(checked((int)jsonBytes))));
        }
    }
}
