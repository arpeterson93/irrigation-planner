"""Spec tests for the CSV grid import/export (PLAN.md section 10, tasks 56-60).

Python twin of docs/js/gridcsv.js: the functions below re-implement
buildGridCsv / parseGridCsv exactly, so these tests pin the grid format,
rectangle decomposition, and rejection paths the same way tests/ pins the
coverage and schedule math. Change one side, change the other.

Grid contract (PLAN.md 10.1): 1 cell = 1 sq ft, W = round(widthFt),
H = round(heightFt). Row 1 = header (blank corner, then 1..W). Row 2 = far/top
edge (y = H); last data row = y = 1 (near edge).
"""
import csv as csvmod
import io
import re

import pytest

AREA_PALETTE = ["#4caf50", "#2980b9", "#e67e22", "#8e44ad", "#16a085", "#c0392b"]


# --- geometry twin (coverage.js pointInPolygon) ---------------------------- #

def point_in_polygon(pt, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i][0], poly[i][1]
        xj, yj = poly[j][0], poly[j][1]
        hit = ((yi > pt[1]) != (yj > pt[1])) and (
            pt[0] < (xj - xi) * (pt[1] - yi) / ((yj - yi) or 1e-12) + xi
        )
        if hit:
            inside = not inside
        j = i
    return inside


# --- buildGridCsv twin ----------------------------------------------------- #

def _cell_token(x, y, state):
    pt = (x - 0.5, y - 0.5)
    for i, ds in enumerate(state.get("deadSpaces", [])):
        if point_in_polygon(pt, ds["polygon"]):
            return "d%d" % (i + 1)
    for i, yz in enumerate(state.get("yardZones", [])):
        if point_in_polygon(pt, yz["polygon"]):
            return "y%d" % (i + 1)
    return ""


def build_grid_csv(state):
    W = round(state["yard"]["widthFt"])
    H = round(state["yard"]["heightFt"])
    out = io.StringIO()
    w = csvmod.writer(out, lineterminator="\r\n")
    w.writerow([""] + [str(x) for x in range(1, W + 1)])
    for y in range(H, 0, -1):
        w.writerow([str(y)] + [_cell_token(x, y, state) for x in range(1, W + 1)])
    w.writerow([])
    for i, z in enumerate(state.get("yardZones", [])):
        w.writerow(["y%d" % (i + 1), z.get("name", "")])
    for i, d in enumerate(state.get("deadSpaces", [])):
        w.writerow(["d%d" % (i + 1), "%s (%s)" % (d.get("label", ""), d.get("kind", "other"))])
    return out.getvalue()


# --- parseGridCsv twin ----------------------------------------------------- #

def _connected_components(cell_set):
    """4-connected flood fill; returns list of component cell-sets (task 61)."""
    unvisited = set(cell_set)
    comps = []
    while unvisited:
        start = next(iter(unvisited))
        unvisited.discard(start)
        comp = {start}
        stack = [start]
        while stack:
            x, y = stack.pop()
            for nb in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if nb in unvisited:
                    unvisited.discard(nb)
                    comp.add(nb)
                    stack.append(nb)
        comps.append(comp)
    return comps


def _signed_area(pts):
    """Shoelace signed area (CCW positive)."""
    a = 0
    n = len(pts)
    for i in range(n):
        p, q = pts[i], pts[(i + 1) % n]
        a += p[0] * q[1] - q[0] * p[1]
    return a / 2


def _collapse_collinear(pts):
    n = len(pts)
    out = []
    for i in range(n):
        prev, cur, nxt = pts[(i - 1) % n], pts[i], pts[(i + 1) % n]
        cross = (cur[0] - prev[0]) * (nxt[1] - cur[1]) - (cur[1] - prev[1]) * (nxt[0] - cur[0])
        if cross != 0:
            out.append(cur)
    return out


def _trace_component(cells):
    """Edge-cancellation boundary trace of one component to a single ring; holes
    are filled into the outer silhouette (outer/positive loop kept)."""
    edges = set()

    def add_edge(a, b):
        if (b, a) in edges:
            edges.discard((b, a))
        else:
            edges.add((a, b))

    for (x, y) in cells:
        bl, br, tr, tl = (x - 1, y - 1), (x, y - 1), (x, y), (x - 1, y)
        add_edge(bl, br)  # bottom
        add_edge(br, tr)  # right
        add_edge(tr, tl)  # top
        add_edge(tl, bl)  # left

    start_map = {}
    for (a, b) in edges:
        start_map.setdefault(a, []).append((a, b))

    remaining = set(edges)
    loops = []
    while remaining:
        cur = next(iter(remaining))
        start_pt = cur[0]
        ring = []
        while cur is not None and cur in remaining:
            remaining.discard(cur)
            end = cur[1]
            ring.append([end[0], end[1]])
            if end == start_pt:
                break
            cur = next((e for e in start_map.get(end, []) if e in remaining), None)
        loops.append(ring)

    best, best_area = None, 0
    for ring in loops:
        area = _signed_area(ring)
        if area > best_area:
            best_area, best = area, ring
    corners = _collapse_collinear(best if best is not None else loops[0])
    # Rotate to start at the bottom-left-most corner (min y, then min x) so the
    # output is deterministic and a rectangle reproduces rect()'s vertex order.
    mi = 0
    for i in range(1, len(corners)):
        if corners[i][1] < corners[mi][1] or (corners[i][1] == corners[mi][1] and corners[i][0] < corners[mi][0]):
            mi = i
    return corners[mi:] + corners[:mi]


def parse_grid_csv(text, state):
    W = round(state["yard"]["widthFt"])
    H = round(state["yard"]["heightFt"])
    rows = list(csvmod.reader(io.StringIO(text)))
    if not rows:
        raise ValueError("The CSV file appears to be empty.")

    header_cells = rows[0][1:]
    while header_cells and str(header_cells[-1]).strip() == "":
        header_cells.pop()
    file_w = len(header_cells)

    file_h = 0
    for i in range(1, len(rows)):
        if re.fullmatch(r"\d+", str(rows[i][0] if rows[i] else "").strip()):
            file_h += 1
        else:
            break

    if file_w != W:
        raise ValueError(
            "CSV is %d wide but the yard is set to %d ft wide. Resize the yard or fix the CSV, then re-upload." % (file_w, W))
    if file_h != H:
        raise ValueError(
            "CSV is %d tall but the yard is set to %d ft tall. Resize the yard or fix the CSV, then re-upload." % (file_h, H))

    for x in range(1, W + 1):
        if str(header_cells[x - 1]).strip() != str(x):
            raise ValueError('CSV header column %d should be "%d" but is "%s".' % (x + 1, x, str(header_cells[x - 1]).strip()))
    for r in range(H):
        expected = H - r
        label = str(rows[1 + r][0] if rows[1 + r] else "").strip()
        if label != str(expected):
            raise ValueError('CSV row %d should be labeled %d in column A but is "%s".' % (r + 2, expected, label))

    masks = {}
    for r in range(H):
        y = H - r
        row = rows[1 + r]
        for x in range(1, W + 1):
            raw = str(row[x] if x < len(row) else "").strip()
            if raw == "":
                continue
            if not re.fullmatch(r"[yd]\d+", raw, re.IGNORECASE):
                raise ValueError('Cell at x=%d, y=%d has invalid value "%s". Use blank, a y<number> (yard zone), or a d<number> (dead space).' % (x, y, raw))
            token = raw[0].lower() + str(int(raw[1:]))
            masks.setdefault(token, set()).add((x, y))

    y_tokens = sorted(int(t[1:]) for t in masks if t[0] == "y")
    d_tokens = sorted(int(t[1:]) for t in masks if t[0] == "d")

    yard_zones = []
    for n in y_tokens:
        existing = (state.get("yardZones") or [])[n - 1] if n - 1 < len(state.get("yardZones") or []) else None
        name = existing["name"] if existing else "Area %d" % n
        color = existing["color"] if (existing and existing.get("color")) else AREA_PALETTE[(n - 1) % len(AREA_PALETTE)]
        for comp in _connected_components(masks["y%d" % n]):
            yard_zones.append({"name": name, "color": color, "polygon": _trace_component(comp)})

    dead_spaces = []
    for n in d_tokens:
        existing = (state.get("deadSpaces") or [])[n - 1] if n - 1 < len(state.get("deadSpaces") or []) else None
        label = existing["label"] if existing else "Dead space %d" % n
        kind = (existing.get("kind") or "other") if existing else "other"
        for comp in _connected_components(masks["d%d" % n]):
            dead_spaces.append({"label": label, "kind": kind, "polygon": _trace_component(comp)})

    return {"yardZones": yard_zones, "deadSpaces": dead_spaces}


# --- test helpers ---------------------------------------------------------- #

def rect(x0, y0, x1, y1):
    """Axis-aligned rectangle polygon in feet, bottom-left origin."""
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def category_grid(state, W, H):
    """Per-cell category grid: 'D' dead, 'Y' yard, '' turf. Dead wins."""
    grid = {}
    for y in range(1, H + 1):
        for x in range(1, W + 1):
            pt = (x - 0.5, y - 0.5)
            cat = ""
            if any(point_in_polygon(pt, d["polygon"]) for d in state.get("deadSpaces", [])):
                cat = "D"
            elif any(point_in_polygon(pt, z["polygon"]) for z in state.get("yardZones", [])):
                cat = "Y"
            grid[(x, y)] = cat
    return grid


# --- round-trip tests ------------------------------------------------------ #

class TestRoundTrip:
    def test_simple_rectangles_round_trip_coverage(self):
        state = {
            "yard": {"widthFt": 12, "heightFt": 8},
            "yardZones": [{"name": "Front", "color": "#4caf50", "polygon": rect(0, 0, 6, 8)}],
            "deadSpaces": [{"label": "House", "kind": "house", "polygon": rect(8, 2, 11, 6)}],
        }
        parsed = parse_grid_csv(build_grid_csv(state), state)
        assert category_grid(parsed, 12, 8) == category_grid(state, 12, 8)

    def test_dead_space_hole_inside_yard_zone(self):
        # Yard zone covers the whole yard; a dead space punches a hole in it.
        state = {
            "yard": {"widthFt": 10, "heightFt": 10},
            "yardZones": [{"name": "Lawn", "color": "#4caf50", "polygon": rect(0, 0, 10, 10)}],
            "deadSpaces": [{"label": "Patio", "kind": "patio", "polygon": rect(3, 3, 7, 7)}],
        }
        parsed = parse_grid_csv(build_grid_csv(state), state)
        assert category_grid(parsed, 10, 10) == category_grid(state, 10, 10)
        # Task 61: the yard zone is one contiguous region, so it comes back as a
        # single object whose traced outline silently fills the hole. The dead
        # space still masks the hole (category_grid equality above proves it).
        assert len(parsed["yardZones"]) == 1
        assert len(parsed["deadSpaces"]) == 1

    def test_dead_wins_over_yard_on_overlap(self):
        # Overlapping yard zone and dead space: overlap cells must read as dead.
        state = {
            "yard": {"widthFt": 8, "heightFt": 8},
            "yardZones": [{"name": "A", "color": "#4caf50", "polygon": rect(0, 0, 8, 8)}],
            "deadSpaces": [{"label": "D", "kind": "other", "polygon": rect(2, 2, 5, 5)}],
        }
        csv_text = build_grid_csv(state)
        # A cell inside the overlap is exported as a dead token, not a yard token.
        rows = list(csvmod.reader(io.StringIO(csv_text)))
        # cell (x=3, y=3): row for y=3 is row index (H - 3) + 1 = 6; column x=3.
        H = 8
        r = (H - 3) + 1
        assert rows[r][3] == "d1"


class TestDecomposition:
    def test_two_disjoint_blocks_share_one_token(self):
        # Hand-built CSV: two separated y1 blocks -> two rectangles, one token.
        state = {"yard": {"widthFt": 7, "heightFt": 3}, "yardZones": [], "deadSpaces": []}
        header = ",1,2,3,4,5,6,7"
        # y1 at columns 1-2 and columns 6-7, all three rows.
        line = lambda y: "%d,y1,y1,,,,y1,y1" % y
        text = "\r\n".join([header, line(3), line(2), line(1)]) + "\r\n"
        parsed = parse_grid_csv(text, state)
        assert len(parsed["yardZones"]) == 2
        assert {tuple(map(tuple, z["polygon"])) for z in parsed["yardZones"]} == {
            tuple(map(tuple, rect(0, 0, 2, 3))),
            tuple(map(tuple, rect(5, 0, 7, 3))),
        }

    def test_l_shape_single_component_is_one_object(self):
        # A single connected L-shaped region must stay one object (task 61), not
        # fragment into a per-rectangle pile. 4x4 block with a 2x2 corner bite.
        state = {"yard": {"widthFt": 4, "heightFt": 4}, "yardZones": [], "deadSpaces": []}
        lines = [
            ",1,2,3,4",
            "4,y1,y1,,",   # top-right 2x2 removed
            "3,y1,y1,,",
            "2,y1,y1,y1,y1",
            "1,y1,y1,y1,y1",
        ]
        text = "\r\n".join(lines) + "\r\n"
        parsed = parse_grid_csv(text, state)
        assert len(parsed["yardZones"]) == 1
        poly = parsed["yardZones"][0]["polygon"]
        # Six corners for an L; deterministic order from the bottom-left corner.
        assert [list(p) for p in poly] == [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]]
        # The traced outline covers exactly the L's cells and nothing else.
        present = set()
        for yy in range(1, 5):
            for xx in range(1, 5):
                if point_in_polygon((xx - 0.5, yy - 0.5), poly):
                    present.add((xx, yy))
        expected = {(x, y) for x in (1, 2) for y in (1, 2, 3, 4)} | {(x, y) for x in (3, 4) for y in (1, 2)}
        assert present == expected


class TestRejections:
    def _state(self, w=5, h=4):
        return {"yard": {"widthFt": w, "heightFt": h}, "yardZones": [], "deadSpaces": []}

    def _valid_text(self, w=5, h=4):
        return build_grid_csv(self._state(w, h))

    def test_bad_token(self):
        state = self._state(5, 4)  # W=5, H=4
        # Valid header/labels, one garbage cell at x=2 in the y=4 row.
        lines = [",1,2,3,4,5", "4,,x9,,,", "3,,,,,", "2,,,,,", "1,,,,,"]
        text = "\r\n".join(lines) + "\r\n"
        with pytest.raises(ValueError, match=r'invalid value "x9"'):
            parse_grid_csv(text, state)

    def test_wrong_width(self):
        state = self._state(5, 4)
        text = build_grid_csv(self._state(6, 4))  # a 6-wide file
        with pytest.raises(ValueError, match=r"CSV is 6 wide but the yard is set to 5"):
            parse_grid_csv(text, state)

    def test_wrong_height(self):
        state = self._state(5, 4)
        text = build_grid_csv(self._state(5, 3))  # a 3-tall file
        with pytest.raises(ValueError, match=r"CSV is 3 tall but the yard is set to 4"):
            parse_grid_csv(text, state)
