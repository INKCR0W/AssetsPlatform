import io
import struct
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit(3)


def resize_images(limit):
    source = sys.stdin.buffer
    destination = sys.stdout.buffer
    while header := source.read(4):
        length, = struct.unpack("<I", header)
        payload = source.read(length)
        if len(payload) != length:
            raise ValueError("Incomplete preview image payload")
        with Image.open(io.BytesIO(payload), formats=("PNG", "JPEG")) as image:
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
        resize_images(int(sys.argv[1]))
    except (OSError, ValueError, struct.error) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
