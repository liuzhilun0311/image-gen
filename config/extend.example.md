# 默认参数与完整选项

技能：`image-gen`

## 参数选择

设置绘图时默认使用的模型、张数、分辨率、比例、质量及保存目录等参数。直接修改下方 JSON 中的对应值，可选项及含义见“参数说明”；`""` 表示不指定。

```json
{
  "version": 1,
  "defaults": {
    "model": "gpt-image-2.5-flare",
    "n": 1,
    "resolution": "1k",
    "aspect_ratio": "1:1",
    "quality": "low",
    "background": "",
    "output_format": "png",
    "output_compression": "",
    "moderation": "",
    "out_dir": "./image_output",
    "show_info": false
  }
}
```

## 参数说明

| **参数名称** | **必选/可选** | **当前默认值** | **用户选择** | **参数意义及可选项** |
| -------- | --------- | --------- | -------- | ------------ |
| 模型 `model` | 可选 | `gpt-image-2.5-flare` | | 选择生成模型。<br>`gpt-image-2.5-flare`：别名 `flare`，使用 GPT 密钥。<br>`gpt-image-2.5-sunburst`：别名 `sunburst`，使用 GPT 密钥。<br>`gemini-nano-banana-2.1`：别名 `banana`，使用独立 Banana 密钥，不自动切换。 |
| 生成张数 `n` | 可选 | `1` | | 本次生成的候选图片总数。<br>`1`：一张。<br>`2`：两张。<br>`3`：三张。<br>`4`：四张。<br>有参考图时固定 `1`；Banana 多图由独立请求完成。 |
| 分辨率档位 `resolution` | 可选 | `1k` | | 控制请求的尺寸等级。<br>`1k`：1K 档。<br>`2k`：2K 档。<br>`4k`：4K 档。<br>实际像素随模型及比例变化，可能取整。 |
| 图片比例 `aspect_ratio` | 可选 | `1:1` | | 使用宽:高格式；未标注模型的选项三模型共用。<br>`1:1`：正方形。<br>`3:2`：横版。<br>`2:3`：竖版。<br>`4:3`：横版。<br>`3:4`：竖版。<br>`5:4`：横版。<br>`4:5`：竖版。<br>`16:9`：宽屏横版。<br>`9:16`：手机竖版。<br>`21:9`：超宽横版。<br>`2:1`：宽横版，仅 GPT。<br>`1:2`：长竖版，仅 GPT。<br>`9:21`：超长竖版，仅 GPT。<br>`1:4`：长条竖版，仅 Banana。<br>`4:1`：长条横版，仅 Banana。<br>`1:8`：极长竖版，仅 Banana。<br>`8:1`：极长横版，仅 Banana。 |
| 质量 `quality` | 可选 | `low` | | GPT 使用图像质量档位。<br>`auto`：自动。<br>`low`：低。<br>`medium`：中。<br>`high`：高。<br>`xhigh`：更高。<br>`max`：最高。<br>Banana 仅将 `low` 映射为最低思考档，其余均为默认思考档。 |
| 背景 `background` | 可选 | `""` | | 控制 GPT 的背景处理。<br>`""`：不指定。<br>`auto`：服务自动决定。<br>`opaque`：不透明。<br>`transparent`：透明，仅 GPT，必须用 PNG/WebP。<br>Banana 不发送该参数，背景写入提示词。 |
| 输出格式 `output_format` | 可选 | `png` | | 选择图片输出格式。<br>`""`：不指定。<br>`png`：PNG 图片，可承载透明通道。<br>`jpeg`：JPEG 图片，不支持透明，仅 GPT。<br>`webp`：WebP 图片，可承载透明通道，仅 GPT。<br>Banana 只接受不指定或 PNG，仅为格式预期，不发送编码控制字段。 |
| 输出压缩 `output_compression` | 条件可选 | `""` | | 仅 GPT 的 JPEG/WebP 适用。<br>`""`：不指定，使用服务默认。<br>`0`～`100`：自定义整数，效果由服务决定。<br>其他情况必须留空。 |
| 内容审核模式 `moderation` | 条件可选 | `""` | | 仅 GPT 适用，实际行为由服务决定。<br>`""`：不指定。<br>`auto`：自动审核。<br>`low`：服务支持的较宽松审核设置。<br>Banana 必须留空。 |
| 图片保存目录 `out_dir` | 可选 | `./image_output` | | 图片及生成记录的保存位置。<br>相对路径：例如 `./image_output`，以执行时工作目录为基准。<br>绝对路径：例如 `F:/images`，保存到指定位置。<br>Windows JSON 路径使用 `/` 或 `\\`。 |
| 图片信息展示 `show_info` | 可选 | `false` | | 控制生成后是否显示图片信息，使用 JSON 布尔值。<br>`true`：显示模型、实际分辨率、请求比例、已保存张数、质量、输出格式、背景设置、总耗时、输入/输出 token。<br>`false`：不显示信息摘要。<br>多图显示请求合计 token；服务未返回时标注“未提供”。 |

提示词和参考图路径在本次任务中提供，不作为长期默认。优先级：命令行参数 > 同名进程环境变量 > `.env` 兼容的旧绘图项 > 本文件 > 内置默认。

## 单次任务输入与固定限制

提示词必需，通过 `--prompt` 或位置参数传入；参考图可选，通过重复的 `--image` 传入本机 PNG、JPEG、WebP 路径，不接受远程 URL。GPT 最多 16 张参考图，Banana 最多 14 张，每张不超过 10MB。Banana 编码后的请求体上限为 95,000,000 字节。这些是固定能力限制，不是可调配置。

`--check-config`、`models`、`--help`、`--dry-run` 是检查或执行命令；`--execution-config` 是调用方的单次任务快照路径，不保存为默认。完整选项通过脚本 `--help` 查询。

## 覆盖与兼容

旧绘图环境变量：`GPT_IMAGE2_MODEL`、`GPT_IMAGE2_N`、`GPT_IMAGE2_RESOLUTION`、`GPT_IMAGE2_ASPECT_RATIO`、`GPT_IMAGE2_QUALITY`、`GPT_IMAGE2_BACKGROUND`、`GPT_IMAGE2_OUTPUT_FORMAT`、`GPT_IMAGE2_OUTPUT_COMPRESSION`、`GPT_IMAGE2_MODERATION`、`GPT_IMAGE2_OUT_DIR`、`GPT_IMAGE2_SHOW_INFO`。迁移长期默认到本文件后移除旧 `.env` 绘图项；明确为空的环境变量可清除对应可选默认。

调用方完整任务快照覆盖绘图环境默认值，冲突的命令行绘图参数会被拒绝；快照不得包含密钥或服务地址等运行配置。
