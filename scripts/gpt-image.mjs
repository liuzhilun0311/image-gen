export function createGPTRequest(options, images, size) {
  const fields = {
    model: options.model, prompt: options.prompt, size,
    ...(!images.length ? { n: options.n } : {}),
  };
  for (const [key, value] of Object.entries({
    quality: options.quality, background: options.background, output_format: options.outputFormat,
    output_compression: options.outputCompression, moderation: options.moderation,
  })) {
    if (value !== "" && value !== undefined && value !== null) fields[key] = value;
  }
  return {
    url: `${options.baseUrl}${images.length ? "/images/edits" : "/images/generations"}`,
    summary: fields, count: 1,
    contentType: images.length ? null : "application/json",
    makeBody: () => {
      if (!images.length) return JSON.stringify(fields);
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
      for (const image of images) {
        form.append("image", new Blob([image.raw], { type: image.mimeType }), image.filename);
      }
      return form;
    },
    parse: (body) => ({
      data: Array.isArray(body.data) ? body.data : [],
      usage: body.usage ?? null, model: body.model ?? null, created: body.created ?? null,
    }),
  };
}
