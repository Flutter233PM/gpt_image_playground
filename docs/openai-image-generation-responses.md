# OpenAI Image Generation Guide - Responses API Notes

Source: <https://developers.openai.com/api/docs/guides/image-generation?api=responses#overview>

Captured with Playwright on 2026-04-27.

This file is a condensed Markdown note generated from the official OpenAI image generation guide. It is not a verbatim mirror of the page.

## Overview

OpenAI image generation supports two main integration paths:

- Image API: direct single-purpose image generation and image editing endpoints.
- Responses API: conversational or multi-step workflows that call image generation as a built-in tool.

Use the Image API when the app only needs one image generation or edit request from a prompt. Use the Responses API when the app needs multi-turn image workflows, iterative editing, or image inputs and outputs in conversation context.

GPT Image models may require organization verification before use. The guide names GPT Image models such as `gpt-image-2`, `gpt-image-1.5`, `gpt-image-1`, and `gpt-image-1-mini`.

## Responses API Basic Generation

In the Responses API, image generation is invoked through the `image_generation` tool. The model response can contain `image_generation_call` outputs whose `result` field is base64 image data.

Minimal JavaScript shape:

```ts
import OpenAI from "openai";
import fs from "node:fs";

const client = new OpenAI();

const response = await client.responses.create({
  model: "gpt-5.5",
  input: "Generate a product photo of a matte black desk lamp.",
  tools: [{ type: "image_generation" }],
});

const image = response.output.find((item) => item.type === "image_generation_call");
if (image?.result) {
  fs.writeFileSync("image.png", Buffer.from(image.result, "base64"));
}
```

Minimal Python shape:

```py
from openai import OpenAI
import base64

client = OpenAI()

response = client.responses.create(
    model="gpt-5.5",
    input="Generate a product photo of a matte black desk lamp.",
    tools=[{"type": "image_generation"}],
)

image = next((item for item in response.output if item.type == "image_generation_call"), None)
if image and image.result:
    with open("image.png", "wb") as f:
        f.write(base64.b64decode(image.result))
```

## Image API Basic Generation

For direct image generation, call the Image API endpoint with a GPT Image model such as `gpt-image-2`.

```ts
const result = await client.images.generate({
  model: "gpt-image-2",
  prompt: "A clean editorial illustration of a writing desk at sunrise.",
});

const imageBase64 = result.data?.[0]?.b64_json;
```

Equivalent HTTP endpoint:

```http
POST /v1/images/generations
Content-Type: application/json
Authorization: Bearer $OPENAI_API_KEY
```

## Multi-Turn Image Generation

The Responses API can continue image workflows across turns. Two common approaches are:

- Use `previous_response_id` to continue from a prior response.
- Include an earlier `image_generation_call` item in the new request input.

The image tool supports an optional `action` value:

- `auto`: let the model decide whether to generate or edit.
- `generate`: force a new image.
- `edit`: force editing an image already present in context.

If `action: "edit"` is used without an image in context, the request can fail. Prefer `auto` unless the app can guarantee the context contains an editable image.

### Playground continuation policy

The official API supports `previous_response_id` and `image_generation_call`
item references, but this playground should not rely on those identifiers in a
browser-to-sub2api deployment where upstream storage may be disabled.

The app still saves each returned `response.id` in local IndexedDB for history
and diagnostics. For the next turn, it sends the latest generated image from
local history back as an `input_image` data URL, optionally with a compact
transcript prompt. This keeps the local conversation UI unchanged while avoiding
non-persisted `ig_...` item references and deployment-specific WebSocket v2
continuation requirements.

## Streaming

Both Responses API image generation and Image API generation support streaming. For Responses API, set:

```ts
const stream = await client.responses.create({
  model: "gpt-5.5",
  input: "Draw a river through a winter landscape.",
  stream: true,
  tools: [{ type: "image_generation", partial_images: 2 }],
});
```

The `partial_images` option accepts `0` through `3` partial images. A request may receive fewer partial images than requested if the final image completes quickly. In streamed Responses API output, partial image events use the `response.image_generation_call.partial_image` event type.

## Revised Prompts

When using image generation through the Responses API, the mainline model may revise the prompt for better image generation. The revised prompt is available on the `image_generation_call` object through `revised_prompt`.

Use this field for debugging, audit trails, and user-facing "what was actually sent" views.

## Image Editing

Image editing supports:

- Editing existing images.
- Generating a new image from one or more reference images.
- Editing selected areas using a mask.

For Responses API edits, provide images in the input content, then include the `image_generation` tool. Image inputs may be file IDs or image URLs/data URLs, depending on the workflow.

For the Image API, use:

```http
POST /v1/images/edits
Content-Type: multipart/form-data
Authorization: Bearer $OPENAI_API_KEY
```

Typical multipart fields:

- `model`: for example `gpt-image-2`.
- `prompt`: edit or generation instruction.
- `image[]`: one or more input images.
- `mask`: optional mask image.

## Masks

Mask behavior for GPT Image:

- The edited image and mask must have the same format and dimensions.
- The mask must be under 50 MB.
- The mask must contain an alpha channel.
- If multiple images are provided, the mask applies to the first image.
- Masking is prompt-guided, so the model may not follow the exact mask boundary perfectly.

For black-and-white masks, convert to RGBA and use the grayscale channel as alpha before upload.

## Image Input Fidelity

For `gpt-image-2`, omit `input_fidelity`. The guide says this model processes image inputs at high fidelity automatically and does not allow changing the parameter.

Because image inputs are processed at high fidelity, edit requests with reference images can consume more input image tokens.

## Output Customization

Common output options:

- `size`: image dimensions.
- `quality`: `low`, `medium`, `high`, or `auto`.
- `output_format`: `png`, `jpeg`, or `webp`.
- `output_compression`: `0` to `100`, for JPEG and WebP.
- `background`: `auto` or opaque settings where supported.
- `moderation`: `auto` or `low`.

`gpt-image-2` currently does not support transparent backgrounds. Requests with `background: "transparent"` are not supported for that model.

JPEG is usually faster than PNG, so prefer JPEG when latency matters and transparency is not required.

## Size And Quality

`gpt-image-2` accepts many resolutions when they satisfy all constraints:

- Maximum edge length is at most `3840px`.
- Both width and height are multiples of `16px`.
- Long edge to short edge ratio is no more than `3:1`.
- Total pixels are at least `655,360` and at most `8,294,400`.

Common sizes mentioned by the guide include:

- `1024x1024`
- `1536x1024`
- `1024x1536`
- `2048x2048`
- `2048x1152`
- `3840x2160`
- `2160x3840`
- `auto`

Use `quality: "low"` for drafts, thumbnails, and fast iteration. Move to `medium` or `high` for final assets.

## Moderation

Prompts and generated images are filtered by OpenAI content policy. For GPT Image models, the `moderation` parameter supports:

- `auto`: default standard filtering.
- `low`: less restrictive filtering.

The playground exposes these two values as audit strength choices. There are no
additional `medium` or `high` moderation levels documented for this parameter.

## Supported Models

For Responses API image generation, the guide says `gpt-5` and newer mainline models should support the image generation tool. Check the target model's detail page before relying on tool support in production.

For direct Image API calls, use GPT Image models such as `gpt-image-2` where available to the organization.

## Limitations

Known limitations listed in the guide:

- Complex prompts can take up to about 2 minutes.
- Text rendering is improved but can still be imperfect.
- Recurring characters or brand assets may not stay perfectly consistent.
- Precise structured composition can still be difficult.

For deployed web apps, set reverse proxy read timeouts above 2 minutes for image generation and edits. A 60-second default Nginx timeout is too short for some edit requests.

## Cost And Latency Notes

Cost and latency depend on:

- Input text tokens.
- Input image tokens for edits and reference-image workflows.
- Image output tokens.
- Output size and quality.

For streamed partial images, each partial image adds extra output image tokens. The guide notes `100` additional image output tokens per partial image.

Use the official pricing page or pricing calculator for current prices; do not hardcode pricing values in application logic.

## Integration Checklist

- For direct browser apps, avoid cross-origin API calls when possible; use same-origin proxying for `/v1/*`.
- For image edits, allow large multipart bodies, for example `256m`.
- Set proxy read/send timeouts to at least `600s` for long generation and edit jobs.
- Store and expose request IDs when available for support.
- Surface `revised_prompt` in debug views for Responses API image generation.
- Reuse the Image API size picker for Responses image-generation tool requests.
- Validate size constraints before sending user-entered custom dimensions.
- Normalize custom sizes to multiples of `16px`.
- Avoid `background: "transparent"` with `gpt-image-2`.
- Do not send `input_fidelity` with `gpt-image-2`.

