import io
import struct
import sys

try:
    from PIL import Image, ImageFile
except ImportError:
    sys.exit(3)

ImageFile.LOAD_TRUNCATED_IMAGES = False
Image.MAX_IMAGE_PIXELS = 8192 * 8192
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_IMAGE_AXIS = 8192


def process_images(limit):
    source = sys.stdin.buffer
    destination = sys.stdout.buffer
    while header := source.read(4):
        length, = struct.unpack("<I", header)
        if not 0 < length <= MAX_IMAGE_BYTES:
            raise ValueError("Invalid preview image payload size")
        payload = source.read(length)
        if len(payload) != length:
            raise ValueError("Incomplete preview image payload")
        with Image.open(io.BytesIO(payload), formats=("PNG", "JPEG")) as image:
            if max(image.size) > MAX_IMAGE_AXIS:
                raise ValueError("Preview image dimension exceeds its limit")
            image.load()
            if limit is None:
                continue
            image_format = image.format
            if max(image.size) <= limit:
                output = payload
            else:
                if image.mode == "P":
                    image = image.convert("RGBA")
                image.thumbnail((limit, limit), Image.Resampling.LANCZOS)
                resized = io.BytesIO()
                options = {"quality": 85} if image_format == "JPEG" else {}
                image.save(resized, format=image_format, **options)
                output = resized.getvalue()
        destination.write(struct.pack("<I", len(output)))
        destination.write(output)


if __name__ == "__main__":
    try:
        command = sys.argv[1]
        process_images(None if command == "--validate" else int(command))
    except (OSError, ValueError, struct.error, Image.DecompressionBombError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
