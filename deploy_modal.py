"""
Modal.com deployment: antenna simulation endpoint with T4 GPU.

Usage:
    uv run --with modal --with fastapi modal serve deploy_modal.py     # dev
    uv run --with modal --with fastapi modal deploy deploy_modal.py    # prod
"""

import modal
from fastapi import Request
from fastapi.responses import JSONResponse, PlainTextResponse

app = modal.App("antenna-sim")

# Driver 535 still ships libnvidia-vulkan-producer.so as a standalone lib.
# We extract it at build time from the .run installer and write the ICD JSON.
NVIDIA_DRIVER_VERSION = "535.183.06"
NVIDIA_DRIVER_URL = f"https://us.download.nvidia.com/tesla/{NVIDIA_DRIVER_VERSION}/NVIDIA-Linux-x86_64-{NVIDIA_DRIVER_VERSION}.run"

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.6.3-base-ubuntu22.04", add_python="3.11"
    )
    .env({"XDG_RUNTIME_DIR": "/tmp"})
    .apt_install("curl", "ca-certificates", "libvulkan1", "libxext6", "libegl1", "kmod")
    # Extract Vulkan ICD + dependencies from NVIDIA driver 535
    .run_commands(
        f"curl -fsSL -o /tmp/nvidia.run {NVIDIA_DRIVER_URL}"
        " && chmod +x /tmp/nvidia.run"
        " && /tmp/nvidia.run --extract-only --target /tmp/nv"
        " && cp /tmp/nv/libnvidia-vulkan-producer.so.* /usr/lib/x86_64-linux-gnu/"
        " && cp /tmp/nv/libnvidia-glvkspirv.so.* /usr/lib/x86_64-linux-gnu/"
        " && cp /tmp/nv/libnvidia-gpucomp.so.* /usr/lib/x86_64-linux-gnu/ 2>/dev/null || true"
        f" && ln -sf libnvidia-vulkan-producer.so.{NVIDIA_DRIVER_VERSION} /usr/lib/x86_64-linux-gnu/libnvidia-vulkan-producer.so"
        " && ldconfig"
        " && mkdir -p /usr/share/vulkan/icd.d"
        ' && echo \'{"file_format_version":"1.0.1","ICD":{"library_path":"libnvidia-vulkan-producer.so","api_version":"1.3"}}\''
        " > /usr/share/vulkan/icd.d/nvidia_icd.json"
        " && rm -rf /tmp/nvidia.run /tmp/nv",
    )
    # Node.js 22
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
    )
    # Project files + webgpu
    .add_local_file("package.json", "/srv/package.json", copy=True)
    .add_local_dir("scripts", "/srv/scripts", copy=True)
    .add_local_dir("src", "/srv/src", copy=True)
    .add_local_dir("app", "/srv/app", copy=True)
    .add_local_dir("build-wasm", "/srv/build-wasm", copy=True)
    .run_commands("cd /srv && npm install webgpu")
)


@app.function(
    gpu="T4",
    image=image,
    timeout=300,
    scaledown_window=30,
    min_containers=0,
    max_containers=1,
)
@modal.fastapi_endpoint(method="POST")
async def simulate(request: Request):
    """Run FDTD simulation from XML, return browser-compatible JSON."""
    import subprocess
    import json
    import os

    body = await request.body()
    if not body:
        return JSONResponse({"error": "Empty request body"}, status_code=400)

    xml = body.decode("utf-8")

    # Quick diagnostic
    if xml.strip() == "diag":
        diag = subprocess.run(
            ["bash", "-c",
             "nvidia-smi -L 2>/dev/null; echo '---';"
             "cat /usr/share/vulkan/icd.d/nvidia_icd.json 2>/dev/null; echo '---';"
             "ls -la /usr/lib/x86_64-linux-gnu/libnvidia-vulkan* 2>/dev/null; echo '---';"
             "cd /srv && node -e \""
             "const {create,globals}=require('webgpu');"
             "Object.assign(globalThis,globals);"
             "async function t(){"
             "  const n={gpu:create([])};"
             "  const a=await n.gpu.requestAdapter();"
             "  if(!a){console.log('adapter: null');return;}"
             "  console.log('adapter features:',JSON.stringify([...a.features]));"
             "  const d=await a.requestDevice();"
             "  console.log('device: OK');"
             "  d.destroy();"
             "}"
             "t().catch(e=>console.error('ERR:',e.message))"
             "\" 2>&1"],
            capture_output=True, text=True, timeout=30,
        )
        return PlainTextResponse(diag.stdout + diag.stderr)

    import tempfile

    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as out_f:
        out_path = out_f.name

    try:
        # Write stdout to file to avoid pipe buffer limits
        with open(out_path, 'w') as out_f:
            result = subprocess.run(
                ["node", "/srv/scripts/run-node-sim.mjs", "--stdin", "--json"],
                input=xml,
                stdout=out_f,
                stderr=subprocess.PIPE,
                text=True,
                cwd="/srv",
                timeout=240,
            )

        if result.returncode != 0:
            stderr_tail = result.stderr[-2000:] if result.stderr else "no output"
            return JSONResponse(
                {"error": "Simulation failed", "stderr": stderr_tail},
                status_code=500,
            )

        with open(out_path, 'r') as f:
            stdout = f.read()
    finally:
        os.unlink(out_path)

    # The WASM C++ engine may print to stdout before the JSON.
    idx = stdout.find('{"type":"done"')
    if idx == -1:
        return JSONResponse(
            {"error": "No JSON in output", "stdout": stdout[:500]},
            status_code=500,
        )

    try:
        data = json.loads(stdout[idx:])
    except json.JSONDecodeError as e:
        return JSONResponse(
            {"error": f"Invalid JSON: {e}", "stdout": stdout[idx:idx+500]},
            status_code=500,
        )

    return data
