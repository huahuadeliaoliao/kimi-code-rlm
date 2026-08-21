Read an image or video file and return model-visible media.

A `<system>` block reports the mime type, byte size, original image dimensions, and whether the image was delivered unchanged, downsampled, cropped, or at native resolution. Give relative coordinates first and derive absolute coordinates from the reported original dimensions, not from the displayed copy.

Large images may be downsampled. When fine detail matters, use `region` with original-image pixel coordinates for a full-fidelity crop, or use `full_resolution` when the whole file fits the per-image limit. Re-reading the same downsampled file without either option does not reveal more detail. After generating or editing media, read the result before relying on it.

If compression cannot fit the file within model limits, use RlmKernel with work access and an available image processor to create a smaller copy, then read that copy; do not retry the unchanged file. Independent media files may be read in parallel.

This tool accepts only image and video files. Use RlmKernel to inspect text files or directory contents. Invalid paths and files larger than ${MAX_MEDIA_MEGABYTES}MB return an error.

**Capabilities**
