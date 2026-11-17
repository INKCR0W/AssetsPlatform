using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace AssetsPlatform.Tools
{
    public sealed class WorkbenchPrefabImporter : AssetPostprocessor
    {
        internal const string LegacyConfigurationFormat = "asset-workbench-unity/configuration/1";
        internal const string CompactConfigurationFormat = "asset-workbench-unity/configuration/2";
        private const int MaxAnimationCount = 1024;
        private static readonly HashSet<string> pendingModels = new HashSet<string>(StringComparer.Ordinal);

        [Serializable]
        private sealed class Configuration
        {
            public string format;
            public string model;
            public string[] animations;
            public string defaultClipName;
            public int animationCount = -1;
            public string defaultClipNameSha256;
        }

        private static void OnPostprocessAllAssets(string[] importedAssets, string[] deletedAssets,
            string[] movedAssets, string[] movedFromAssetPaths)
        {
            foreach (var path in importedAssets.Concat(movedAssets))
            {
                if (Path.GetExtension(path).Equals(".glb", StringComparison.OrdinalIgnoreCase))
                    pendingModels.Add(path);
                else if (Path.GetFileName(path) == "asset.json")
                {
                    var configuration = ReadConfiguration(path);
                    if (configuration != null)
                        pendingModels.Add(Combine(Path.GetDirectoryName(path), Path.GetFileName(configuration.model)));
                }
            }
            if (pendingModels.Count == 0) return;
            EditorApplication.delayCall -= PreparePending;
            EditorApplication.delayCall += PreparePending;
        }

        [MenuItem("Assets/AssetsPlatform/Prepare Model Prefab")]
        private static void PrepareSelection()
        {
            foreach (var guid in Selection.assetGUIDs)
                pendingModels.Add(AssetDatabase.GUIDToAssetPath(guid));
            PreparePending();
        }

        [MenuItem("Assets/AssetsPlatform/Prepare Model Prefab", true)]
        private static bool HasSelectedModel() =>
            Selection.assetGUIDs.Any(guid => Path.GetExtension(AssetDatabase.GUIDToAssetPath(guid))
                .Equals(".glb", StringComparison.OrdinalIgnoreCase));

        private static void PreparePending()
        {
            var models = pendingModels.ToArray();
            pendingModels.Clear();
            foreach (var model in models)
            {
                try { EnsurePrefab(model); }
                catch (Exception error) { Debug.LogWarning($"AssetsPlatform: {model}: {error.Message}"); }
            }
        }

        public static string EnsurePrefab(string assetPath)
        {
            if (!IsProjectAsset(assetPath) || !assetPath.EndsWith(".glb", StringComparison.OrdinalIgnoreCase))
                return null;

            var directory = Path.GetDirectoryName(assetPath);
            var configuration = ReadConfiguration(Combine(directory, "asset.json"));
            if (configuration == null || Path.GetFileName(configuration.model) != Path.GetFileName(assetPath))
                return null;

            var model = AssetDatabase.LoadMainAssetAtPath(assetPath) as GameObject;
            if (!model) return null;

            var stem = Path.GetFileNameWithoutExtension(assetPath);
            var prefabPath = Combine(directory, stem + "-Ready.prefab");
            var controllerPath = Combine(directory, stem + "-Animations.controller");
            if (AssetExists(prefabPath))
                return IsVariantOf(prefabPath, assetPath) ? prefabPath : null;
            if (AssetExists(controllerPath)) return null;

            var clips = AssetDatabase.LoadAllAssetsAtPath(assetPath).OfType<AnimationClip>().ToArray();
            var defaultClip = FindDefaultClip(configuration, clips);
            if (clips.Any(clip => clip.legacy))
                throw new InvalidDataException("Use the glTFast Mecanim animation import setting to prepare the prefab.");

            AnimatorController controller = null;
            var scene = EditorSceneManager.NewPreviewScene();
            try
            {
                var instance = PrefabUtility.InstantiatePrefab(model, scene) as GameObject;
                if (!instance) throw new InvalidDataException("The imported GLB cannot be instantiated as a prefab.");
                if (clips.Length > 0)
                {
                    var animator = FindAnimator(instance);
                    controller = AnimatorController.CreateAnimatorControllerAtPath(controllerPath);
                    if (!controller) throw new IOException("Unity could not create the animation controller.");
                    BindClips(controller, clips, defaultClip);
                    animator.runtimeAnimatorController = controller;
                }
                PrefabUtility.SaveAsPrefabAsset(instance, prefabPath, out bool saved);
                if (!saved) throw new IOException("Unity could not save the prepared prefab.");
                return prefabPath;
            }
            catch
            {
                if (controller && AssetDatabase.LoadAssetAtPath<AnimatorController>(controllerPath) == controller)
                    AssetDatabase.DeleteAsset(controllerPath);
                throw;
            }
            finally
            {
                EditorSceneManager.ClosePreviewScene(scene);
            }
        }

        private static Animator FindAnimator(GameObject instance)
        {
            var animators = instance.GetComponentsInChildren<Animator>(true);
            if (animators.Length > 1)
                throw new InvalidDataException("The imported GLB has more than one animation root.");
            return animators.Length == 1 ? animators[0] : instance.AddComponent<Animator>();
        }

        private static AnimationClip FindDefaultClip(Configuration configuration, AnimationClip[] clips)
        {
            if (configuration.format == CompactConfigurationFormat)
            {
                if (clips.Length != configuration.animationCount)
                    throw new InvalidDataException("The GLB importer did not produce the expected number of animation clips.");
                if (clips.Length == 0) return null;

                using var sha = SHA256.Create();
                var matches = clips.Where(clip =>
                    BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(clip.name)))
                        .Replace("-", "").ToLowerInvariant() == configuration.defaultClipNameSha256
                ).Take(2).ToArray();
                if (matches.Length != 1)
                    throw new InvalidDataException("The GLB importer did not produce a unique matching default animation clip.");
                return matches[0];
            }

            if (clips.Length < configuration.animations.Length)
                throw new InvalidDataException("The GLB importer did not produce all selected animation clips.");
            if (string.IsNullOrEmpty(configuration.defaultClipName))
                return clips.FirstOrDefault(clip => clip.name == configuration.animations.FirstOrDefault());

            var legacyDefault = clips.SingleOrDefault(clip => clip.name == configuration.defaultClipName);
            if (legacyDefault == null)
                throw new InvalidDataException("The GLB importer did not produce the configured default animation clip.");
            return legacyDefault;
        }

        private static void BindClips(AnimatorController controller, AnimationClip[] clips, AnimationClip defaultClip)
        {
            var machine = controller.layers[0].stateMachine;
            AnimatorState first = null;
            foreach (var clip in clips)
            {
                var state = machine.AddState(clip.name);
                state.motion = clip;
                if (!first || clip == defaultClip) first = state;
            }
            machine.defaultState = first;
            AssetDatabase.SaveAssetIfDirty(controller);
        }

        private static bool IsVariantOf(string prefabPath, string modelPath)
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
            var source = prefab ? PrefabUtility.GetCorrespondingObjectFromSource(prefab) : null;
            return source && AssetDatabase.GetAssetPath(source) == modelPath;
        }

        private static bool AssetExists(string path) =>
            File.Exists(path) || Directory.Exists(path) || File.Exists(path + ".meta") ||
            !string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(path, AssetPathToGUIDOptions.OnlyExistingAssets));

        private static string Combine(string directory, string name) =>
            Path.Combine(directory ?? string.Empty, name).Replace('\\', '/');

        private static Configuration ReadConfiguration(string path)
        {
            if (!IsProjectAsset(path)) return null;
            try
            {
                var file = new FileInfo(path);
                if (!file.Exists || file.Length > 64 * 1024 || file.Attributes.HasFlag(FileAttributes.ReparsePoint))
                    return null;
                var marker = new Configuration();
                JsonUtility.FromJsonOverwrite(File.ReadAllText(path), marker);
                if (!IsSafeRelativePath(marker.model) || !marker.model.EndsWith(".glb", StringComparison.OrdinalIgnoreCase))
                    return null;
                if (marker.format == LegacyConfigurationFormat)
                    return marker.animations != null ? marker : null;
                return marker.format == CompactConfigurationFormat && HasValidCompactAnimationSettings(marker) ? marker : null;
            }
            catch (IOException) { return null; }
            catch (ArgumentException) { return null; }
        }

        private static bool HasValidCompactAnimationSettings(Configuration marker)
        {
            if (marker.animationCount < 0 || marker.animationCount > MaxAnimationCount) return false;
            var digest = marker.defaultClipNameSha256;
            // Unity's JSON decoder can represent null as an empty string.
            if (marker.animationCount == 0) return string.IsNullOrEmpty(digest);
            return digest?.Length == 64 && digest.All(character =>
                (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'));
        }

        private static bool IsSafeRelativePath(string path) =>
            !string.IsNullOrEmpty(path) && path.Split('/').All(segment =>
                segment.Length != 0 && segment != "." && segment != ".." &&
                segment == segment.Trim() && !segment.EndsWith(".", StringComparison.Ordinal) &&
                !segment.Any(character => char.IsControl(character) || "\\:*?\"<>|".Contains(character)));

        private static bool IsProjectAsset(string path)
        {
            if (!IsSafeRelativePath(path) || !path.StartsWith("Assets/", StringComparison.Ordinal))
                return false;
            var current = new DirectoryInfo(Path.GetDirectoryName(path));
            while (current != null)
            {
                if (!current.Exists || current.Attributes.HasFlag(FileAttributes.ReparsePoint)) return false;
                if (current.FullName.Equals(Application.dataPath.Replace('/', Path.DirectorySeparatorChar),
                    StringComparison.OrdinalIgnoreCase))
                    return !File.Exists(path) || !File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint);
                current = current.Parent;
            }
            return false;
        }
    }
}
