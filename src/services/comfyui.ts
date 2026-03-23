/**
 * ComfyUI REST client — comprehensive model support.
 *
 * Image models: Flux 1 Dev, Flux 2 Klein, SDXL, Z-Image Turbo, Qwen Image,
 *               Illustrious, Qwen Edit (image editing)
 * Video models: Wan 2.2 I2V, Wan 2.2 T2V
 * LoRA support: per-model LoRA stacking
 */

// ── Model types ──────────────────────────────────────────────────

export type ImageModel =
  | "flux-dev"
  | "flux-klein"
  | "sdxl"
  | "zimage"
  | "qwen-image"
  | "illustrious"
  | "qwen-edit";

export type VideoModel = "wan-i2v" | "wan-t2v";

export type ComfyModel = ImageModel | VideoModel;

export interface GenerateImageOptions {
  prompt: string;
  model?: ImageModel;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  negative?: string;
  loras?: Array<{ name: string; strength?: number }>;
}

export interface EditImageOptions {
  prompt: string;
  inputImagePath: string; // local path — will be uploaded first
  steps?: number;
  seed?: number;
}

export interface GenerateVideoOptions {
  prompt: string;
  model?: VideoModel;
  width?: number;
  height?: number;
  length?: number; // frames (must be 4n+1 for wan, e.g. 81)
  steps?: number;
  seed?: number;
  negative?: string;
  inputImagePath?: string; // for I2V — local path, uploaded first
  loras?: Array<{ name: string; strength?: number }>;
  fps?: number;
}

// ── Client ───────────────────────────────────────────────────────

export class ComfyUIClient {
  constructor(private baseUrl: string) {}

  // ── Image generation ─────────────────────────────────────────

  async generateImage(opts: GenerateImageOptions): Promise<Buffer> {
    const model = opts.model ?? "flux-klein";
    const width = opts.width ?? 1024;
    const height = opts.height ?? 1024;
    const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 32);

    const workflow = this.buildImageWorkflow(model, opts.prompt, width, height, seed, opts.steps, opts.negative, opts.loras);
    const promptId = await this.submitPrompt(workflow);
    const filename = await this.pollImageCompletion(promptId, 180_000);
    return this.downloadFile(filename);
  }

  // ── Image editing ────────────────────────────────────────────

  async editImage(opts: EditImageOptions): Promise<Buffer> {
    const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 32);
    const steps = opts.steps ?? 20;

    // Upload the source image first
    const inputFilename = await this.uploadImage(opts.inputImagePath);

    const workflow = {
      prompt: {
        "1": { class_type: "UNETLoader", inputs: { unet_name: "Qwen\\qwen-image\\qwenImageEdit2511_fp8.safetensors", weight_dtype: "default" } },
        "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors", type: "qwen2_vl" } },
        "3": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
        "4": { class_type: "LoadImage", inputs: { image: inputFilename } },
        "5": { class_type: "ImageScaleToTotalPixels", inputs: { upscale_method: "lanczos", megapixels: 1.0, image: ["4", 0] } },
        "6": { class_type: "VAEEncode", inputs: { pixels: ["5", 0], vae: ["3", 0] } },
        "7": { class_type: "TextEncodeQwenImageEdit", inputs: { clip: ["2", 0], prompt: opts.prompt, image: ["5", 0], vae: ["3", 0] } },
        "8": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } },
        "9": { class_type: "KSampler", inputs: { seed, steps, cfg: 4.0, sampler_name: "euler", scheduler: "simple", denoise: 1.0, model: ["1", 0], positive: ["7", 0], negative: ["8", 0], latent_image: ["6", 0] } },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["3", 0] } },
        "11": { class_type: "SaveImage", inputs: { filename_prefix: "discord_edit", images: ["10", 0] } },
      },
    };

    const promptId = await this.submitPrompt(workflow);
    const filename = await this.pollImageCompletion(promptId, 180_000);
    return this.downloadFile(filename);
  }

  // ── Video generation ─────────────────────────────────────────

  async generateVideo(opts: GenerateVideoOptions): Promise<Buffer> {
    const model = opts.model ?? "wan-t2v";
    const width = opts.width ?? 832;
    const height = opts.height ?? 480;
    const length = opts.length ?? 81;
    const steps = opts.steps ?? 30;
    const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 32);
    const fps = opts.fps ?? 16;
    const negative = opts.negative ?? "";

    let inputFilename: string | undefined;
    if (opts.inputImagePath) {
      inputFilename = await this.uploadImage(opts.inputImagePath);
    }

    const workflow = this.buildVideoWorkflow(model, opts.prompt, negative, width, height, length, steps, seed, fps, opts.loras, inputFilename);
    const promptId = await this.submitPrompt(workflow);
    const filename = await this.pollVideoCompletion(promptId, 600_000); // 10 min timeout for video
    return this.downloadFile(filename);
  }

  // ── Upload ───────────────────────────────────────────────────

  async uploadImage(localPath: string): Promise<string> {
    const file = Bun.file(localPath);
    const formData = new FormData();
    formData.append("image", file);
    formData.append("subfolder", "agent_inputs");
    formData.append("type", "input");

    const resp = await fetch(`${this.baseUrl}/upload/image`, {
      method: "POST",
      body: formData,
    });

    if (!resp.ok) {
      throw new Error(`Image upload failed: ${resp.status}`);
    }

    const data = (await resp.json()) as { name?: string; subfolder?: string };
    if (!data.name) {
      throw new Error("Upload returned no filename");
    }
    // Return the path ComfyUI expects: subfolder/name or just name
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
  }

  // ── Image workflow builders ──────────────────────────────────

  private buildImageWorkflow(
    model: ImageModel,
    prompt: string,
    width: number,
    height: number,
    seed: number,
    stepsOverride?: number,
    negative?: string,
    loras?: Array<{ name: string; strength?: number }>,
  ): object {
    switch (model) {
      case "flux-klein":
      case "flux-dev":
        return this.buildFluxWorkflow(model, prompt, width, height, seed, stepsOverride, loras);
      case "sdxl":
        return this.buildSdxlWorkflow(prompt, width, height, seed, stepsOverride, negative, loras);
      case "zimage":
        return this.buildZImageWorkflow(prompt, width, height, seed, stepsOverride, loras);
      case "qwen-image":
        return this.buildQwenImageWorkflow(prompt, width, height, seed, stepsOverride, loras);
      case "illustrious":
        return this.buildIllustriousWorkflow(prompt, width, height, seed, stepsOverride, negative, loras);
      case "qwen-edit":
        throw new Error("Use editImage() for qwen-edit model");
    }
  }

  private buildFluxWorkflow(
    variant: "flux-klein" | "flux-dev",
    prompt: string, width: number, height: number, seed: number,
    stepsOverride?: number,
    loras?: Array<{ name: string; strength?: number }>,
  ): object {
    const isKlein = variant === "flux-klein";
    const unet = isKlein ? "flux-2-klein-9b-fp8.safetensors" : "flux.1-dev-SRPO-BFL-bf16.safetensors";
    const cfg = isKlein ? 1.0 : 3.5;
    const steps = stepsOverride ?? (isKlein ? 20 : 30);
    const scheduler = isKlein ? "simple" : "normal";

    const nodes: Record<string, object> = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: unet, weight_dtype: "default" } },
      "2": { class_type: "DualCLIPLoader", inputs: { clip_name1: "t5xxl_fp8_e4m3fn.safetensors", clip_name2: "clip_l.safetensors", type: "flux" } },
      "3": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
      "4": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } },
      "7": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
    };

    // Insert LoRA chain if provided
    let modelRef: [string, number] = ["1", 0];
    let clipRef: [string, number] = ["2", 0];
    if (loras?.length) {
      let nodeId = 20;
      for (const lora of loras) {
        const id = String(nodeId++);
        nodes[id] = {
          class_type: "LoraLoader",
          inputs: {
            model: modelRef,
            clip: clipRef,
            lora_name: lora.name,
            strength_model: lora.strength ?? 1.0,
            strength_clip: lora.strength ?? 1.0,
          },
        };
        modelRef = [id, 0];
        clipRef = [id, 1];
      }
      // Re-point text encoders to use LoRA-modified CLIP
      nodes["3"] = { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: clipRef } };
      nodes["6"] = { class_type: "CLIPTextEncode", inputs: { text: "", clip: clipRef } };
    }

    nodes["5"] = { class_type: "KSampler", inputs: { seed, steps, cfg, sampler_name: "euler", scheduler, denoise: 1.0, model: modelRef, positive: ["3", 0], negative: ["6", 0], latent_image: ["4", 0] } };
    nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["7", 0] } };
    nodes["9"] = { class_type: "SaveImage", inputs: { filename_prefix: "discord_bot", images: ["8", 0] } };

    return { prompt: nodes };
  }

  private buildSdxlWorkflow(
    prompt: string, width: number, height: number, seed: number,
    stepsOverride?: number, negative?: string,
    loras?: Array<{ name: string; strength?: number }>,
  ): object {
    const steps = stepsOverride ?? 30;
    const neg = negative ?? "ugly, blurry, low quality, deformed";

    const nodes: Record<string, object> = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "analogMadnessXL.safetensors" } },
      "4": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    };

    let modelRef: [string, number] = ["1", 0];
    let clipRef: [string, number] = ["1", 1];
    if (loras?.length) {
      let nodeId = 20;
      for (const lora of loras) {
        const id = String(nodeId++);
        nodes[id] = {
          class_type: "LoraLoader",
          inputs: { model: modelRef, clip: clipRef, lora_name: lora.name, strength_model: lora.strength ?? 1.0, strength_clip: lora.strength ?? 1.0 },
        };
        modelRef = [id, 0];
        clipRef = [id, 1];
      }
    }

    nodes["2"] = { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: clipRef } };
    nodes["3"] = { class_type: "CLIPTextEncode", inputs: { text: neg, clip: clipRef } };
    nodes["5"] = { class_type: "KSampler", inputs: { seed, steps, cfg: 7.0, sampler_name: "dpmpp_2m", scheduler: "karras", denoise: 1.0, model: modelRef, positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0] } };
    nodes["6"] = { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } };
    nodes["7"] = { class_type: "SaveImage", inputs: { filename_prefix: "discord_bot", images: ["6", 0] } };

    return { prompt: nodes };
  }

  private buildZImageWorkflow(
    prompt: string, width: number, height: number, seed: number,
    stepsOverride?: number,
    loras?: Array<{ name: string; strength?: number }>,
  ): object {
    const steps = stepsOverride ?? 6; // Z-Image Turbo is fast, 4-8 steps
    const nodes: Record<string, object> = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors", weight_dtype: "default" } },
      "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_8b_fp8mixed.safetensors", type: "qwen_image" } },
      "4": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
      "7": { class_type: "VAELoader", inputs: { vae_name: "zImage_vae.safetensors" } },
    };

    let modelRef: [string, number] = ["1", 0];
    let clipRef: [string, number] = ["2", 0];
    if (loras?.length) {
      let nodeId = 20;
      for (const lora of loras) {
        const id = String(nodeId++);
        nodes[id] = {
          class_type: "LoraLoader",
          inputs: { model: modelRef, clip: clipRef, lora_name: lora.name, strength_model: lora.strength ?? 1.0, strength_clip: lora.strength ?? 1.0 },
        };
        modelRef = [id, 0];
        clipRef = [id, 1];
      }
    }

    nodes["3"] = { class_type: "TextEncodeZImageOmni", inputs: { clip: clipRef, prompt, auto_resize_images: true } };
    nodes["6"] = { class_type: "CLIPTextEncode", inputs: { text: "", clip: clipRef } };
    nodes["5"] = { class_type: "KSampler", inputs: { seed, steps, cfg: 5.0, sampler_name: "euler", scheduler: "simple", denoise: 1.0, model: modelRef, positive: ["3", 0], negative: ["6", 0], latent_image: ["4", 0] } };
    nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["7", 0] } };
    nodes["9"] = { class_type: "SaveImage", inputs: { filename_prefix: "discord_bot", images: ["8", 0] } };

    return { prompt: nodes };
  }

  private buildQwenImageWorkflow(
    prompt: string, width: number, height: number, seed: number,
    stepsOverride?: number,
    loras?: Array<{ name: string; strength?: number }>,
  ): object {
    const steps = stepsOverride ?? 20;
    const nodes: Record<string, object> = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2512_fp8_e4m3fn.safetensors", weight_dtype: "default" } },
      "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors", type: "qwen_image" } },
      "4": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
      "7": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
    };

    let modelRef: [string, number] = ["1", 0];
    let clipRef: [string, number] = ["2", 0];
    if (loras?.length) {
      let nodeId = 20;
      for (const lora of loras) {
        const id = String(nodeId++);
        nodes[id] = {
          class_type: "LoraLoader",
          inputs: { model: modelRef, clip: clipRef, lora_name: lora.name, strength_model: lora.strength ?? 1.0, strength_clip: lora.strength ?? 1.0 },
        };
        modelRef = [id, 0];
        clipRef = [id, 1];
      }
    }

    nodes["3"] = { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: clipRef } };
    nodes["6"] = { class_type: "CLIPTextEncode", inputs: { text: "", clip: clipRef } };
    nodes["5"] = { class_type: "KSampler", inputs: { seed, steps, cfg: 4.0, sampler_name: "euler", scheduler: "simple", denoise: 1.0, model: modelRef, positive: ["3", 0], negative: ["6", 0], latent_image: ["4", 0] } };
    nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["7", 0] } };
    nodes["9"] = { class_type: "SaveImage", inputs: { filename_prefix: "discord_bot", images: ["8", 0] } };

    return { prompt: nodes };
  }

  private buildIllustriousWorkflow(
    prompt: string, width: number, height: number, seed: number,
    stepsOverride?: number, negative?: string,
    loras?: Array<{ name: string; strength?: number }>,
  ): object {
    const steps = stepsOverride ?? 25;
    const neg = negative ?? "worst quality, low quality, blurry, bad anatomy";

    const nodes: Record<string, object> = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "Illustrious\\anime\\oneObsession_v18.safetensors" } },
      "4": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    };

    let modelRef: [string, number] = ["1", 0];
    let clipRef: [string, number] = ["1", 1];
    if (loras?.length) {
      let nodeId = 20;
      for (const lora of loras) {
        const id = String(nodeId++);
        nodes[id] = {
          class_type: "LoraLoader",
          inputs: { model: modelRef, clip: clipRef, lora_name: lora.name, strength_model: lora.strength ?? 1.0, strength_clip: lora.strength ?? 1.0 },
        };
        modelRef = [id, 0];
        clipRef = [id, 1];
      }
    }

    nodes["2"] = { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: clipRef } };
    nodes["3"] = { class_type: "CLIPTextEncode", inputs: { text: neg, clip: clipRef } };
    nodes["5"] = { class_type: "KSampler", inputs: { seed, steps, cfg: 7.0, sampler_name: "euler_ancestral", scheduler: "normal", denoise: 1.0, model: modelRef, positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0] } };
    nodes["6"] = { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } };
    nodes["7"] = { class_type: "SaveImage", inputs: { filename_prefix: "discord_bot", images: ["6", 0] } };

    return { prompt: nodes };
  }

  // ── Video workflow builder ───────────────────────────────────

  private buildVideoWorkflow(
    model: VideoModel,
    prompt: string, negative: string,
    width: number, height: number, length: number,
    steps: number, seed: number, fps: number,
    loras?: Array<{ name: string; strength?: number }>,
    inputImageFilename?: string,
  ): object {
    const isI2V = model === "wan-i2v";
    const unet = isI2V
      ? "Wan2.2-I2V-A14B-HighNoise-Q8_0.gguf"
      : "Wan2_2-T2V-A14B_HIGH_fp8_e4m3fn_scaled_KJ.safetensors";

    const nodes: Record<string, object> = {};

    // LoRA chain for video (WanVideoLoraSelect)
    let loraRef: [string, number] | null = null;
    if (loras?.length) {
      let nodeId = 30;
      for (const lora of loras) {
        const id = String(nodeId++);
        nodes[id] = {
          class_type: "WanVideoLoraSelect",
          inputs: {
            lora: lora.name,
            strength: lora.strength ?? 1.0,
            ...(loraRef ? { prev_lora: loraRef } : {}),
          },
        };
        loraRef = [id, 0];
      }
    }

    // Model loader
    nodes["1"] = {
      class_type: "WanVideoModelLoader",
      inputs: {
        model: unet,
        base_precision: "bf16",
        quantization: "disabled",
        load_device: "offload_device",
        ...(loraRef ? { lora: loraRef } : {}),
      },
    };

    // Text encoder
    nodes["2"] = { class_type: "LoadWanVideoClipTextEncoder", inputs: { model: "umt5-xxl-fp8.safetensors", device: "cpu" } };
    nodes["3"] = { class_type: "WanVideoTextEncode", inputs: { positive_prompt: prompt, negative_prompt: negative, t5: ["2", 0], force_offload: true } };

    // VAE
    nodes["4"] = { class_type: "WanVideoVAELoader", inputs: { vae_name: "Wan2_1_VAE_bf16.safetensors" } };

    // Image-to-Video or Text-to-Video latent
    if (isI2V && inputImageFilename) {
      nodes["10"] = { class_type: "LoadImage", inputs: { image: inputImageFilename } };
      nodes["5"] = {
        class_type: "WanImageToVideo",
        inputs: {
          positive: ["3", 0], negative: ["3", 1], vae: ["4", 0],
          width, height, length, batch_size: 1,
          start_image: ["10", 0],
        },
      };
    } else {
      nodes["5"] = {
        class_type: "WanImageToVideo",
        inputs: {
          positive: ["3", 0], negative: ["3", 1], vae: ["4", 0],
          width, height, length, batch_size: 1,
        },
      };
    }

    // CLIP vision for I2V
    if (isI2V && inputImageFilename) {
      nodes["11"] = { class_type: "CLIPVisionLoader", inputs: { clip_name: "siglip-so400m-patch14-384\\model.safetensors" } };
      nodes["12"] = { class_type: "WanVideoClipVisionEncode", inputs: { clip_vision: ["11", 0], image: ["10", 0] } };
      // Sampler with clip vision
      nodes["6"] = {
        class_type: "WanVideoSampler",
        inputs: {
          model: ["1", 0], image_embeds: ["5", 0],
          steps, cfg: 6.0, shift: 5.0, seed,
          force_offload: true, scheduler: "unipc",
          riflex_freq_index: 0,
          text_embeds: ["3", 0],
        },
      };
    } else {
      nodes["6"] = {
        class_type: "WanVideoSampler",
        inputs: {
          model: ["1", 0], image_embeds: ["5", 0],
          steps, cfg: 6.0, shift: 5.0, seed,
          force_offload: true, scheduler: "unipc",
          riflex_freq_index: 0,
          text_embeds: ["3", 0],
        },
      };
    }

    // Decode
    nodes["7"] = {
      class_type: "WanVideoDecode",
      inputs: {
        vae: ["4", 0], samples: ["6", 0],
        enable_vae_tiling: true,
        tile_x: 272, tile_y: 272,
        tile_stride_x: 144, tile_stride_y: 128,
      },
    };

    // Save as MP4
    nodes["8"] = {
      class_type: "VHS_VideoCombine",
      inputs: {
        images: ["7", 0],
        frame_rate: fps,
        loop_count: 0,
        filename_prefix: "discord_video",
        format: "video/h264-mp4",
        pingpong: false,
        save_output: true,
        pix_fmt: "yuv420p",
        crf: 19,
        save_metadata: true,
      },
    };

    return { prompt: nodes };
  }

  // ── Shared API methods ───────────────────────────────────────

  async submitPrompt(workflow: object): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workflow),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`ComfyUI /prompt failed (${resp.status}): ${text.slice(0, 500)}`);
    }

    const data = (await resp.json()) as { prompt_id?: string };
    if (!data.prompt_id) {
      throw new Error("ComfyUI returned no prompt_id");
    }
    return data.prompt_id;
  }

  async pollImageCompletion(promptId: string, timeoutMs: number): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const resp = await fetch(`${this.baseUrl}/history/${promptId}`);
      if (!resp.ok) { await Bun.sleep(3000); continue; }

      const data = (await resp.json()) as Record<string, {
        outputs?: Record<string, { images?: Array<{ filename: string; type: string }> }>;
      }>;

      const entry = data[promptId];
      if (entry?.outputs) {
        for (const nodeOutput of Object.values(entry.outputs)) {
          if (nodeOutput.images?.length) {
            return nodeOutput.images[0].filename;
          }
        }
      }
      await Bun.sleep(3000);
    }
    throw new Error(`ComfyUI generation timed out after ${timeoutMs / 1000}s`);
  }

  async pollVideoCompletion(promptId: string, timeoutMs: number): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const resp = await fetch(`${this.baseUrl}/history/${promptId}`);
      if (!resp.ok) { await Bun.sleep(5000); continue; }

      const data = (await resp.json()) as Record<string, {
        outputs?: Record<string, {
          images?: Array<{ filename: string; type: string }>;
          gifs?: Array<{ filename: string; subfolder: string; type: string; format: string }>;
        }>;
      }>;

      const entry = data[promptId];
      if (entry?.outputs) {
        for (const nodeOutput of Object.values(entry.outputs)) {
          // VHS_VideoCombine outputs in gifs array
          if (nodeOutput.gifs?.length) {
            return nodeOutput.gifs[0].filename;
          }
          // Fallback to images
          if (nodeOutput.images?.length) {
            return nodeOutput.images[0].filename;
          }
        }
      }
      await Bun.sleep(5000);
    }
    throw new Error(`Video generation timed out after ${timeoutMs / 1000}s`);
  }

  async downloadFile(filename: string): Promise<Buffer> {
    const resp = await fetch(
      `${this.baseUrl}/view?filename=${encodeURIComponent(filename)}&type=output`,
    );
    if (!resp.ok) {
      throw new Error(`Failed to download: ${resp.status}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  // ── Introspection ────────────────────────────────────────────

  async listModels(type: "checkpoints" | "unet" | "loras" | "vae" | "clip"): Promise<string[]> {
    const resp = await fetch(`${this.baseUrl}/models/${type}`);
    if (!resp.ok) return [];
    return (await resp.json()) as string[];
  }
}
