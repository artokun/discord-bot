# Skill: Image Generation via ComfyUI

Generate and edit images using the ComfyUI server at `https://unc-cozy.artokun.io/`.

## API Overview

ComfyUI exposes a REST API. The workflow is:
1. POST `/prompt` with a workflow JSON → get a `prompt_id`
2. Poll `/history/{prompt_id}` until complete
3. Download result from `/view?filename=X&subfolder=Y&type=output`

## Quick Start — Text to Image (Flux 2 Klein)

```bash
# 1. Submit the workflow
PROMPT_ID=$(curl -s https://unc-cozy.artokun.io/prompt \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": {
      "1": {
        "class_type": "UNETLoader",
        "inputs": {
          "unet_name": "flux-2-klein-9b-Q8_0.gguf",
          "weight_dtype": "default"
        }
      },
      "2": {
        "class_type": "DualCLIPLoader",
        "inputs": {
          "clip_name1": "t5xxl_fp8_e4m3fn.safetensors",
          "clip_name2": "clip_l.safetensors",
          "type": "flux"
        }
      },
      "3": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": "YOUR PROMPT HERE",
          "clip": ["2", 0]
        }
      },
      "4": {
        "class_type": "EmptyLatentImage",
        "inputs": {
          "width": 1024,
          "height": 1024,
          "batch_size": 1
        }
      },
      "5": {
        "class_type": "KSampler",
        "inputs": {
          "seed": 42,
          "steps": 20,
          "cfg": 1.0,
          "sampler_name": "euler",
          "scheduler": "simple",
          "denoise": 1.0,
          "model": ["1", 0],
          "positive": ["3", 0],
          "negative": ["6", 0],
          "latent_image": ["4", 0]
        }
      },
      "6": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": "",
          "clip": ["2", 0]
        }
      },
      "7": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": "ae.safetensors"
        }
      },
      "8": {
        "class_type": "VAEDecode",
        "inputs": {
          "samples": ["5", 0],
          "vae": ["7", 0]
        }
      },
      "9": {
        "class_type": "SaveImage",
        "inputs": {
          "filename_prefix": "agent_output",
          "images": ["8", 0]
        }
      }
    }
  }' | python3 -c "import sys,json; print(json.load(sys.stdin)['prompt_id'])")

echo "Prompt ID: $PROMPT_ID"

# 2. Poll for completion (check every 3 seconds)
while true; do
  STATUS=$(curl -s "https://unc-cozy.artokun.io/history/$PROMPT_ID")
  if echo "$STATUS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if '$PROMPT_ID' in d:
    outputs = d['$PROMPT_ID'].get('outputs', {})
    if outputs:
        for node_id, out in outputs.items():
            imgs = out.get('images', [])
            for img in imgs:
                print(f'{img[\"filename\"]}|{img.get(\"subfolder\",\"\")}|{img[\"type\"]}')
        sys.exit(0)
sys.exit(1)
" 2>/dev/null; then
    break
  fi
  sleep 3
done

# 3. Download the result (use filename from step 2)
curl -s "https://unc-cozy.artokun.io/view?filename=FILENAME&type=output" -o output.png
```

## Available Models

### Text-to-Image
| Model | Node | Quality | Speed | Notes |
|-------|------|---------|-------|-------|
| `flux.1-dev-SRPO-BFL-bf16.safetensors` | UNETLoader | Best | ~50s | **Default.** Reliable, high quality. |
| `flux-2-klein-9b-fp8.safetensors` | UNETLoader | Good | Fast | Flux 2 Klein — needs `mistral_3_small_flux2_fp8.safetensors` CLIP |
| `Qwen-Rapid-AIO-SFW-v23.safetensors` | CheckpointLoaderSimple | Good | Medium | Qwen-based, good for realistic |

### Image-to-Image / Video
| Model | Use Case |
|-------|----------|
| `Qwen\qwen-image\qwenImageEdit2511_fp8.safetensors` | Image editing |
| `Wan Video 2.2 I2V-A14B` | Image to video |

## Workflow Templates

### Template 1: Simple Text-to-Image (Flux Klein)

Best for quick concept art, UI mockups, icons, illustrations.

- Model: `flux-2-klein-9b-Q8_0.gguf`
- Steps: 20, CFG: 1.0, Sampler: euler, Scheduler: simple
- Resolution: 1024x1024 (can go up to 1536x1024 for landscape)

### Template 2: High Quality Photo (Flux Dev)

Best for realistic photos, product shots, hero images.

- Model: `flux.1-dev-SRPO-BFL-bf16.safetensors`
- Steps: 30, CFG: 3.5, Sampler: euler, Scheduler: normal
- Resolution: 1024x1024 or 1280x768

### Template 3: SDXL Realistic (AnalogMadness)

Best for photorealistic content, portraits.

- Model: `analogMadnessXL.safetensors` (use CheckpointLoaderSimple)
- Steps: 30, CFG: 7.0, Sampler: dpmpp_2m, Scheduler: karras
- Resolution: 1024x1024
- Needs both positive AND negative prompts

## Prompt Tips

- Be descriptive: "a modern tech startup office with natural lighting, clean desk with laptop, plants, minimalist decor"
- Include style: "digital illustration style", "photograph", "3D render", "watercolor"
- Include quality tags for SDXL: "masterpiece, best quality, highly detailed"
- For Flux models, CFG should be low (1.0-3.5). For SDXL, use higher CFG (5-8).

## Uploading Images (for image-to-image)

```bash
# Upload an image for use as input
curl -s https://unc-cozy.artokun.io/upload/image \
  -F "image=@input.png" \
  -F "subfolder=agent_inputs" \
  -F "type=input" | python3 -m json.tool
```

The response gives you the filename to reference in LoadImage nodes.

## Sharing Results

After generating, upload the output to Linear using the file upload API (see deliverables protocol in tech-lead.md) and post the download link on the ticket.

## Helper Script

For convenience, use `/Users/art/code/0000_dev_mcp/compute/scripts/comfyui-generate.sh`:

```bash
# Generate an image with a single command
./scripts/comfyui-generate.sh "a cute robot mascot for a tech company, flat design, vibrant colors" output.png
```

## Error Handling

- If `/prompt` returns an error, check the `node_errors` field for which node failed
- If polling `/history` times out after 120s, the generation may have failed — check `/queue` for stuck jobs
- If the model isn't loaded yet, the first generation will be slow (model loading)
- Common error: wrong CLIP model for the checkpoint. Flux needs `t5xxl` + `clip_l`. SDXL needs `clip_l` + `clip_g`.
