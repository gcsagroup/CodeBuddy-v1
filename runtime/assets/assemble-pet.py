"""Assemble generated pose grids without drawing or inventing artwork.

The source JSON describes one 6x8 sheet or separate pose grids per animation.
Character geometry and animation come exclusively from the generated images.
"""
import json
import sys
import hashlib
import warnings
from pathlib import Path
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = 16_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)

sources = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
destination = Path(sys.argv[2])
previews = Path(sys.argv[3])
destination.mkdir(parents=True, exist_ok=True)
previews.mkdir(parents=True, exist_ok=True)
states = ['idle', 'wave', 'jump', 'working', 'waiting', 'failed', 'review', 'look']
atlas = Image.new('RGBA', (1152, 1664))
report = []
sheet = Image.open(sources['sheet']).convert('RGBA') if 'sheet' in sources else None
for row, state in enumerate(states):
    source = sheet or Image.open(sources[state]).convert('RGBA')
    columns, rows = sources.get('layouts', {}).get(state, [3, 2])
    if not isinstance(columns, int) or not isinstance(rows, int) or not 1 <= columns <= 12 or not 1 <= rows <= 12 or columns * rows < 6:
        raise ValueError(f'{state}: invalid grid layout')
    cells = []
    for frame in range(6):
        source_frame = sources.get('frameOrder', {}).get(state, list(range(6)))[frame]
        if not isinstance(source_frame, int) or not 0 <= source_frame < (6 if sheet else columns * rows):
            raise ValueError(f'{state}: invalid source frame')
        reviewed_bounds = sources.get('bounds', {}).get(state)
        if reviewed_bounds:
            box = reviewed_bounds[source_frame]
            if box[0] <= 0 or box[1] <= 0 or box[2] >= source.width or box[3] >= source.height:
                raise ValueError(f'{state}:{frame}: generated character reaches the image edge')
            cell = source.crop((box[0] - 2, box[1] - 2, box[2] + 2, box[3] + 2))
        elif sheet is not None:
            cell = source.crop((round(source_frame * source.width / 6), round(row * source.height / 8),
                                round((source_frame + 1) * source.width / 6), round((row + 1) * source.height / 8)))
        else:
            x, y = source_frame % columns, source_frame // columns
            cell = source.crop((round(x * source.width / columns), round(y * source.height / rows),
                                round((x + 1) * source.width / columns), round((y + 1) * source.height / rows)))
        bounds = cell.getchannel('A').point(lambda a: 255 if a > 16 else 0).getbbox()
        if not bounds or bounds[0] == 0 or bounds[1] == 0 or bounds[2] == cell.width or bounds[3] == cell.height:
            raise ValueError(f'{state}:{frame}: source pose is blank or crosses its grid cell; regenerate')
        cells.append((cell.crop(bounds), source_frame))
    # Registration removes generated grid spacing. One scale per action preserves
    # actual squash/stretch; authored jump offsets accompany distinct drawn poses.
    max_width = max(cell.width for cell, _ in cells)
    max_height = max(cell.height for cell, _ in cells)
    jump_offsets = sources.get('jumpOffsets', [0, 6, 24, 32, 14, 0]) if state == 'jump' else [0] * 6
    scale = min(174 / max_width, 152 / max_height)
    frames = []
    for frame, (cell, source_frame) in enumerate(cells):
        cell = cell.resize((round(cell.width * scale), round(cell.height * scale)), Image.Resampling.LANCZOS)
        target = Image.new('RGBA', (192, 208))
        target.alpha_composite(cell, ((192 - cell.width) // 2, 196 - cell.height - jump_offsets[frame]))
        atlas.alpha_composite(target, (frame * 192, row * 208))
        frames.append(target)
        report.append({'state': state, 'frame': frame, 'sourceFrame': source_frame, 'bounds': target.getchannel('A').getbbox()})
    frames[0].save(previews / f'{state}.gif', save_all=True, append_images=frames[1:], duration=167, loop=0, disposal=2, transparency=0)
    if len({hashlib.sha256(frame.tobytes()).digest() for frame in frames}) < 3:
        raise ValueError(f'{state}: animation needs at least three distinct frames')
    for frame in frames:
        alpha = frame.getchannel('A')
        bounds = alpha.point(lambda a: 255 if a > 16 else 0).getbbox()
        occupied = sum(count for value, count in enumerate(alpha.histogram()) if value > 16)
        if not bounds or bounds[0] < 2 or bounds[1] < 2 or bounds[2] > 190 or bounds[3] > 206 or not 100 <= occupied <= 192 * 208 * .85:
            raise ValueError(f'{state}: empty, clipped or opaque output frame')
atlas.save(destination / 'sprites.png', optimize=True)
manifest = dict(schemaVersion=1, id=sources.get('id', 'buddy'), name=sources.get('name', '小伴 Buddy'), description=sources.get('description', 'CodeBuddy 原创'), image='sprites.png', columns=6, rows=8, cellWidth=192, cellHeight=208, fps=6)
(destination / 'pet.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(previews / 'assembly-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
contact = Image.new('RGB', (1152, 8 * 232), '#c9d0d8')
draw = ImageDraw.Draw(contact)
for row, state in enumerate(states):
    draw.text((8, row * 232 + 3), state, fill='black')
    strip = atlas.crop((0, row * 208, 1152, (row + 1) * 208))
    contact.paste(strip, (0, row * 232 + 24), strip)
contact.save(previews / 'contact.jpg')
all_frames = [atlas.crop((f * 192, r * 208, (f + 1) * 192, (r + 1) * 208)) for r in range(7) for f in range(6)]
all_frames[0].save(previews / 'all-states.gif', save_all=True, append_images=all_frames[1:], duration=167, loop=0, disposal=2, transparency=0)
print(json.dumps({'atlas': str(destination / 'sprites.png'), 'frames': len(report), 'states': states}))
(previews / 'validation.json').write_text(json.dumps({'valid': True, 'frames': 48}), encoding='utf-8')
