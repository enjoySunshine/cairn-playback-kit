#!/usr/bin/env python3
"""Check audio channel count and edit lists in the MP4."""
import struct
import sys

with open(sys.argv[1], 'rb') as f:
    data = f.read()


def boxes(start, end):
    pos = start
    while pos + 8 <= end:
        size, btype = struct.unpack('>I4s', data[pos:pos + 8])
        hdr = 8
        if size == 1:
            size = struct.unpack('>Q', data[pos + 8:pos + 16])[0]
            hdr = 16
        yield pos, size, hdr, btype
        pos += size


def find(path, start=0, end=None):
    if end is None:
        end = len(data)
    if not path:
        return [(start, end)]
    out = []
    for pos, size, hdr, btype in boxes(start, end):
        if btype == path[0]:
            out += find(path[1:], pos + hdr, pos + size)
    return out


# mp4a sample entry: entry+24 -> channel count (uint16)
for stsd in find([b'moov', b'trak', b'mdia', b'minf', b'stbl', b'stsd']):
    s, e = stsd
    p = s + 8  # version/flags + entry_count
    while p + 8 <= e:
        esize, etype = struct.unpack('>I4s', data[p:p + 8])
        if etype == b'mp4a':
            channels, sample_size = struct.unpack('>HH', data[p + 24:p + 28])
            rate = struct.unpack('>I', data[p + 32:p + 36])[0] >> 16
            print(f'mp4a channels={channels} sample_size={sample_size} sample_rate={rate}')
        p += esize

# edit lists
for elst in find([b'moov', b'trak', b'edts', b'elst']):
    s, e = elst
    version = data[s]
    count = struct.unpack('>I', data[s + 4:s + 8])[0]
    p = s + 8
    for i in range(count):
        if version == 1:
            dur, media_time, rate = struct.unpack('>QIi', data[p:p + 20])
            p += 20
        else:
            dur, media_time, rate = struct.unpack('>IIi', data[p:p + 12])
            p += 12
        print(f'elst entry: segment_duration={dur} media_time={media_time} rate={rate / 65536}')
