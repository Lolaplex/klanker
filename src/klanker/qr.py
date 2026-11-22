"""Stdlib ISO-18004 QR code generator (Version 1-10, Byte mode, ECC-L)."""
from __future__ import annotations

from typing import Callable

# (version, total_data_cw, ec_per_block, blocks=[(count, data_cw), ...], align_coords)
_VERSIONS: tuple[tuple[int, int, int, tuple[tuple[int, int], ...], tuple[int, ...]], ...] = (
    (1, 19, 7, ((1, 19),), ()),
    (2, 34, 10, ((1, 34),), (6, 18)),
    (3, 55, 15, ((1, 55),), (6, 22)),
    (4, 80, 20, ((1, 80),), (6, 26)),
    (5, 108, 26, ((1, 108),), (6, 30)),
    (6, 136, 18, ((2, 68),), (6, 34)),
    (7, 156, 20, ((2, 78),), (6, 22, 38)),
    (8, 194, 24, ((2, 97),), (6, 24, 42)),
    (9, 232, 30, ((2, 116),), (6, 26, 46)),
    (10, 274, 18, ((2, 68), (2, 69)), (6, 28, 50)),
)

# Format strings already XOR-masked with 0x5412 for EC level L (01) and masks 0..7.
_FORMAT_BITS_L: tuple[int, ...] = (
    0x77C4,
    0x72F3,
    0x7DAA,
    0x789D,
    0x662F,
    0x6318,
    0x6C41,
    0x6976,
)

_VERSION_BITS: dict[int, int] = {
    7: 0x07C94,
    8: 0x085BC,
    9: 0x09A99,
    10: 0x0A4D3,
}

_EXP = [0] * 512
_LOG = [0] * 256
_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _EXP[_i + 255] = _x
    _LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def _rs_gen(ec_len: int) -> list[int]:
    poly = [1]
    for i in range(ec_len):
        nxt = [0] * (len(poly) + 1)
        alpha = _EXP[i]
        for j, coef in enumerate(poly):
            nxt[j] ^= coef
            nxt[j + 1] ^= _gf_mul(coef, alpha)
        poly = nxt
    return poly


def _rs_remainder(data: list[int], ec_len: int) -> list[int]:
    gen = _rs_gen(ec_len)
    res = list(data) + [0] * ec_len
    for i in range(len(data)):
        factor = res[i]
        if factor != 0:
            for j in range(1, len(gen)):
                res[i + j] ^= _gf_mul(gen[j], factor)
    return res[len(data) :]


def _encode_codewords(payload: bytes) -> tuple[int, tuple[int, ...], list[int]]:
    n = len(payload)
    chosen = None
    for spec in _VERSIONS:
        ver, total_data, _ec, _blocks, _align = spec
        count_bits = 8 if ver <= 9 else 16
        if 4 + count_bits + n * 8 <= total_data * 8:
            chosen = spec
            break
    if chosen is None:
        raise ValueError(f"QR payload too long ({n} bytes, max supported ~271)")

    ver, total_data, ec_per_block, blocks_spec, align = chosen
    bits: list[int] = []

    def push_bits(val: int, width: int) -> None:
        for shift in range(width - 1, -1, -1):
            bits.append((val >> shift) & 1)

    push_bits(0b0100, 4)  # Byte mode
    push_bits(n, 8 if ver <= 9 else 16)
    for b in payload:
        push_bits(b, 8)
    rem_cap = total_data * 8 - len(bits)
    push_bits(0, min(4, rem_cap))
    while len(bits) % 8 != 0:
        bits.append(0)

    data_cw: list[int] = []
    for i in range(0, len(bits), 8):
        byte_val = 0
        for bit in bits[i : i + 8]:
            byte_val = (byte_val << 1) | bit
        data_cw.append(byte_val)
    pad_cycle = (0xEC, 0x11)
    p_idx = 0
    while len(data_cw) < total_data:
        data_cw.append(pad_cycle[p_idx & 1])
        p_idx += 1

    data_blocks: list[list[int]] = []
    ec_blocks: list[list[int]] = []
    offset = 0
    for count, bw in blocks_spec:
        for _ in range(count):
            blk = data_cw[offset : offset + bw]
            offset += bw
            data_blocks.append(blk)
            ec_blocks.append(_rs_remainder(blk, ec_per_block))

    out: list[int] = []
    max_data = max(len(b) for b in data_blocks)
    for i in range(max_data):
        for b in data_blocks:
            if i < len(b):
                out.append(b[i])
    for i in range(ec_per_block):
        for ecb in ec_blocks:
            out.append(ecb[i])
    return ver, align, out


_MASK_FNS: tuple[Callable[[int, int], bool], ...] = (
    lambda r, c: (r + c) % 2 == 0,
    lambda r, c: r % 2 == 0,
    lambda r, c: c % 3 == 0,
    lambda r, c: (r + c) % 3 == 0,
    lambda r, c: (r // 2 + c // 3) % 2 == 0,
    lambda r, c: ((r * c) % 2 + (r * c) % 3) == 0,
    lambda r, c: (((r * c) % 2 + (r * c) % 3) % 2) == 0,
    lambda r, c: (((r + c) % 2 + (r * c) % 3) % 2) == 0,
)


def _penalty(mat: list[list[bool]]) -> int:
    n = len(mat)
    score = 0
    # Rule 1: 5+ consecutive same-color modules in rows/cols
    for is_row in (True, False):
        for i in range(n):
            run_len = 1
            prev = mat[i][0] if is_row else mat[0][i]
            for j in range(1, n):
                cur = mat[i][j] if is_row else mat[j][i]
                if cur == prev:
                    run_len += 1
                    if run_len == 5:
                        score += 3
                    elif run_len > 5:
                        score += 1
                else:
                    prev = cur
                    run_len = 1
    # Rule 2: 2x2 uniform blocks
    for r in range(n - 1):
        for c in range(n - 1):
            v = mat[r][c]
            if v == mat[r][c + 1] == mat[r + 1][c] == mat[r + 1][c + 1]:
                score += 3
    # Rule 3: finder-like 1011101 + 4 white pattern
    pat1 = [True, False, True, True, True, False, True, False, False, False, False]
    pat2 = [False, False, False, False, True, False, True, True, True, False, True]
    for i in range(n):
        row = mat[i]
        col = [mat[r][i] for r in range(n)]
        for c in range(n - 10):
            if row[c : c + 11] == pat1 or row[c : c + 11] == pat2:
                score += 40
            if col[c : c + 11] == pat1 or col[c : c + 11] == pat2:
                score += 40
    # Rule 4: dark ratio deviation from 50%
    dark = sum(1 for row in mat for v in row if v)
    pct = (dark * 100) // (n * n)
    lo = abs((pct // 5) * 5 - 50) // 5
    hi = abs(((pct + 4) // 5) * 5 - 50) // 5
    score += min(lo, hi) * 10
    return score


def _stamp_format(mat: list[list[bool]], size: int, mask_id: int) -> None:
    bits = _FORMAT_BITS_L[mask_id]
    for i in range(15):
        bit = bool((bits >> i) & 1)
        if i < 6:
            mat[8][i] = bit
        elif i < 8:
            mat[8][i + 1] = bit
        else:
            mat[8][size - 15 + i] = bit

        if i < 8:
            mat[size - 1 - i][8] = bit
        elif i == 8:
            mat[7][8] = bit
        else:
            mat[14 - i][8] = bit


def _stamp_version(mat: list[list[bool]], size: int, version: int) -> None:
    bits = _VERSION_BITS.get(version)
    if bits is None:
        return
    for i in range(18):
        bit = bool((bits >> i) & 1)
        r = i // 3
        c = size - 11 + (i % 3)
        mat[r][c] = bit
        mat[c][r] = bit


def encode_qr_matrix(text: str) -> list[list[bool]]:
    """Encode ``text`` as a boolean QR matrix (True = dark module)."""
    ver, align, codewords = _encode_codewords(text.encode("utf-8"))
    size = ver * 4 + 17
    base = [[False] * size for _ in range(size)]
    reserved = [[False] * size for _ in range(size)]

    def set_fn(r: int, c: int, val: bool) -> None:
        base[r][c] = val
        reserved[r][c] = True

    # Finders + 1-module white separator
    for fr, fc in ((0, 0), (0, size - 7), (size - 7, 0)):
        for dr in range(-1, 8):
            for dc in range(-1, 8):
                rr, cc = fr + dr, fc + dc
                if 0 <= rr < size and 0 <= cc < size:
                    in_outer = dr in (0, 6) and 0 <= dc <= 6
                    in_side = dc in (0, 6) and 0 <= dr <= 6
                    in_core = 2 <= dr <= 4 and 2 <= dc <= 4
                    set_fn(rr, cc, in_outer or in_side or in_core)

    # Alignment patterns
    for ar in align:
        for ac in align:
            if (ar == align[0] and ac == align[0]) or (ar == align[0] and ac == align[-1]) or (ar == align[-1] and ac == align[0]):
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    dark = max(abs(dr), abs(dc)) != 1
                    set_fn(ar + dr, ac + dc, dark)

    # Timing strips + dark module
    for i in range(8, size - 8):
        val = i % 2 == 0
        set_fn(6, i, val)
        set_fn(i, 6, val)
    set_fn(ver * 4 + 9, 8, True)

    # Reserve format areas
    for i in range(9):
        if i != 6:
            reserved[8][i] = True
            reserved[i][8] = True
    for i in range(8):
        reserved[8][size - 1 - i] = True
        reserved[size - 1 - i][8] = True

    if ver >= 7:
        for i in range(18):
            r = i // 3
            c = size - 11 + (i % 3)
            reserved[r][c] = True
            reserved[c][r] = True

    # Convert codewords to bit stream
    bit_stream: list[bool] = []
    for cw in codewords:
        for shift in range(7, -1, -1):
            bit_stream.append(bool((cw >> shift) & 1))

    # Zig-zag data placement
    bit_idx = 0
    up = True
    col = size - 1
    while col > 0:
        if col == 6:
            col -= 1
        rows = range(size - 1, -1, -1) if up else range(size)
        for r in rows:
            for dc in (0, -1):
                c = col + dc
                if not reserved[r][c]:
                    val = bit_stream[bit_idx] if bit_idx < len(bit_stream) else False
                    base[r][c] = val
                    bit_idx += 1
        up = not up
        col -= 2

    best_mat: list[list[bool]] | None = None
    best_score: int | None = None
    for mask_id, pred in enumerate(_MASK_FNS):
        cand = [
            [
                base[r][c] if reserved[r][c] else (base[r][c] ^ pred(r, c))
                for c in range(size)
            ]
            for r in range(size)
        ]
        _stamp_format(cand, size, mask_id)
        if ver >= 7:
            _stamp_version(cand, size, ver)
        sc = _penalty(cand)
        if best_score is None or sc < best_score:
            best_score = sc
            best_mat = cand
    assert best_mat is not None
    return best_mat


def render_qr_unicode(text: str, *, quiet: int = 2, invert: bool = True) -> str:
    """Render ``text`` as compact UTF-8 half-block QR art (safe for dark terminals)."""
    raw = encode_qr_matrix(text)
    size = len(raw) + 2 * quiet
    padded = [[False] * size for _ in range(size)]
    for r, row in enumerate(raw):
        for c, v in enumerate(row):
            padded[r + quiet][c + quiet] = v

    # When invert=True (dark terminal background): bright glyph = light background,
    # space = dark module.
    def lit(v: bool) -> bool:
        return (not v) if invert else v

    lines: list[str] = []
    for r in range(0, size, 2):
        chars: list[str] = []
        for c in range(size):
            top = lit(padded[r][c])
            bot = lit(padded[r + 1][c]) if (r + 1 < size) else invert
            if top and bot:
                chars.append("█")
            elif top:
                chars.append("▀")
            elif bot:
                chars.append("▄")
            else:
                chars.append(" ")
        lines.append("".join(chars))
    return "\n".join(lines)
