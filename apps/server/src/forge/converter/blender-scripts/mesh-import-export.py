"""
mesh-import-export.py — V2-005b T_b3

Generic Blender CLI helper for the Forge format converter. Loads a mesh
file, clears the default scene, imports the input, then exports to the
target format.

Invocation:
    blender --background --python-exit-code 1 --python <this-file> -- \
        <input-path> <output-path> <input-format> <output-format>

Argument parsing convention:
    `sys.argv` includes Blender's own args before `--`. Everything after
    `--` is what we want. Use `sys.argv[sys.argv.index('--') + 1:]`.

Exit codes:
    0 — success
    1 — any Python exception (Blender propagates this because we set
        `--python-exit-code 1`)

Format compatibility (Blender 4.2):
    - stl: prefer `bpy.ops.wm.stl_import` / `bpy.ops.wm.stl_export` (4.2+).
    - 3mf: requires the `io_mesh_3mf` addon. Blender 4.2 ships it bundled
      but headless invocations must enable it explicitly.
    - obj: prefer `bpy.ops.wm.obj_import` / `bpy.ops.wm.obj_export` (4.0+).
    - fbx: only the legacy `bpy.ops.{import,export}_scene.fbx` exists.
    - glb/gltf: `bpy.ops.import_scene.gltf` (handles both .glb and .gltf).

The script tries the new `wm.<format>_import/export` API first and falls
back to the older `import_mesh.<format>` / `export_mesh.<format>` API on
AttributeError, so it survives version drift across the 4.x line.
"""

import sys
import os

import bpy  # type: ignore[import-not-found]


def _split_argv():
    """Return user args after the `--` separator."""
    if "--" not in sys.argv:
        return []
    return sys.argv[sys.argv.index("--") + 1:]


def _clear_scene():
    """Remove default cube/light/camera so the imported file is alone."""
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def _ensure_3mf_addon():
    """
    Enable the 3MF addon. Blender 4.2 ships it built-in but doesn't
    auto-enable in headless mode. The module name has shifted across
    versions: try the known candidates and surface a clear error if none
    work.
    """
    candidates = ("io_mesh_3mf", "io_scene_3mf", "blender_3mf_format", "mesh_3mf")
    last_err = None
    for name in candidates:
        try:
            bpy.ops.preferences.addon_enable(module=name)
            return name
        except Exception as exc:  # noqa: BLE001 — Blender raises generic Exception
            last_err = exc
    raise RuntimeError(
        f"Could not enable any 3MF addon. Tried: {candidates}. Last error: {last_err}"
    )


def _import_file(path: str, fmt: str):
    if fmt == "stl":
        try:
            bpy.ops.wm.stl_import(filepath=path)
            return
        except AttributeError:
            bpy.ops.import_mesh.stl(filepath=path)
            return
    if fmt == "3mf":
        _ensure_3mf_addon()
        # The 3MF addon registers `import_mesh.threemf` (or similar). Try
        # the known operator names.
        for op in (
            getattr(bpy.ops.import_mesh, "threemf", None),
            getattr(bpy.ops.wm, "threemf_import", None),
            getattr(bpy.ops.import_scene, "threemf", None),
        ):
            if op is not None:
                op(filepath=path)
                return
        raise RuntimeError("3MF import operator not found after addon enable")
    if fmt == "obj":
        try:
            bpy.ops.wm.obj_import(filepath=path)
            return
        except AttributeError:
            bpy.ops.import_scene.obj(filepath=path)
            return
    if fmt == "fbx":
        bpy.ops.import_scene.fbx(filepath=path)
        return
    if fmt in ("glb", "gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
        return
    raise RuntimeError(f"Unsupported input format: {fmt}")


def _export_file(path: str, fmt: str):
    if fmt == "stl":
        try:
            bpy.ops.wm.stl_export(filepath=path)
            return
        except AttributeError:
            bpy.ops.export_mesh.stl(filepath=path)
            return
    if fmt == "3mf":
        _ensure_3mf_addon()
        for op in (
            getattr(bpy.ops.export_mesh, "threemf", None),
            getattr(bpy.ops.wm, "threemf_export", None),
            getattr(bpy.ops.export_scene, "threemf", None),
        ):
            if op is not None:
                op(filepath=path)
                return
        raise RuntimeError("3MF export operator not found after addon enable")
    raise RuntimeError(f"Unsupported output format: {fmt}")


def main() -> int:
    args = _split_argv()
    if len(args) != 4:
        print(
            f"ERROR: expected 4 user args (input output in-fmt out-fmt), got {len(args)}: {args}",
            file=sys.stderr,
        )
        return 1
    input_path, output_path, input_fmt, output_fmt = args

    if not os.path.isfile(input_path):
        print(f"ERROR: input file not found: {input_path}", file=sys.stderr)
        return 1

    _clear_scene()
    _import_file(input_path, input_fmt.lower())
    # Ensure output dir exists.
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    _export_file(output_path, output_fmt.lower())

    if not os.path.isfile(output_path):
        print(
            f"ERROR: export reported success but no file at {output_path}",
            file=sys.stderr,
        )
        return 1

    print(f"OK: wrote {output_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    # We don't need to call sys.exit on success — Blender exits cleanly when
    # the script returns. On exception, --python-exit-code 1 propagates.
    raise SystemExit(main())
