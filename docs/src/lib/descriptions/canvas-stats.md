Returns canvas statistics including node and edge counts, node counts broken down by type, and bounding box information. The bounding box includes:
- `minX`, `minY`: minimum coordinates
- `maxX`, `maxY`: maximum coordinates (x + width, y + height of rightmost/bottommost nodes)
- `width`, `height`: computed dimensions

For an empty canvas, all bounding box values are 0.
