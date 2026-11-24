#!/usr/bin/env python3
"""Minimal MP4 box inspector (stdlib only). Run with: python3 -I inspect_mp4.py <file>"""
import struct
import sys


def boxes(data, start=0, end=None):
    if end is None:
        end = len(data)
    pos = start
    while pos + 8 <= end:
        size, btype = struct.unpack('>I4s', data[pos:pos + 8])
        header = 8
        if size == 1:
            size = struct.unpack('>Q', data[pos + 8:pos + 16])[0]
            header = 16
        elif size == 0:
            size = end - pos
        yield pos, size, header, btype
        pos += size


CONTAINERS = {b'moov', b'trak', b'mdia', b'minf', b'stbl', b'edts', b'udta'}


def walk(data, start, end, depth=0):
    for pos, size, header, btype in boxes(data, start, end):
        body = pos + header
        print('  ' * depth + f'{btype.decode("latin1")} size={size}')
        if btype in CONTAINERS:
            walk(data, body, pos + size, depth + 1)
        elif btype == b'mvhd':
            version = data[body]
            if version == 1:
                timescale = struct.unpack('>I', data[body + 20:body + 24])[0]
                duration = struct.unpack('>Q', data[body + 24:body + 32])[0]
            else:
                timescale = struct.unpack('>I', data[body + 12:body + 16])[0]
                duration = struct.unpack('>I', data[body + 16:body + 20])[0]
            print('  ' * (depth + 1) + f'mvhd timescale={timescale} duration={duration} seconds={duration / timescale:.3f}')
        elif btype == b'tkhd':
            version = data[body]
            if version == 1:
                off = body + 28
                duration = struct.unpack('>Q', data[off:off + 8])[0]
            else:
                off = body + 16
                duration = struct.unpack('>I', data[off:off + 4])[0]
            w, h = struct.unpack('>II', data[pos + size - 8:pos + size])
            print('  ' * (depth + 1) + f'tkhd duration={duration} w={w / 65536} h={h / 65536}')
        elif btype == b'mdhd':
            version = data[body]
            if version == 1:
                timescale = struct.unpack('>I', data[body + 20:body + 24])[0]
                duration = struct.unpack('>Q', data[body + 24:body + 32])[0]
            else:
                timescale = struct.unpack('>I', data[body + 12:body + 16])[0]
                duration = struct.unpack('>I', data[body + 16:body + 20])[0]
            print('  ' * (depth + 1) + f'mdhd timescale={timescale} duration={duration} seconds={duration / timescale:.3f}')
        elif btype == b'stsd':
            i = body + 8
            end_box = pos + size
            while i + 8 <= end_box:
                esize, etype = struct.unpack('>I4s', data[i:i + 8])
                print('  ' * (depth + 1) + f'codec entry: {etype.decode("latin1")}')
                if etype == b'avc1':
                    w, h = struct.unpack('>HH', data[i + 24:i + 28])
                    print('  ' * (depth + 2) + f'avc1 {w}x{h}')
                i += esize
        elif btype == b'stts':
            count = struct.unpack('>I', data[body + 4:body + 8])[0]
            entries = []
            p = body + 8
            for _ in range(min(count, 10)):
                sc, sd = struct.unpack('>II', data[p:p + 8])
                entries.append((sc, sd))
                p += 8
            print('  ' * (depth + 1) + f'stts entries={count} first={entries}')
        elif btype == b'stsz':
            sample_size, count = struct.unpack('>II', data[body + 4:body + 12])
            print('  ' * (depth + 1) + f'stsz uniform_size={sample_size} sample_count={count}')


def main():
    with open(sys.argv[1], 'rb') as f:
        data = f.read()
    print(f'file size: {len(data)} bytes')
    walk(data, 0, len(data))


if __name__ == '__main__':
    main()
