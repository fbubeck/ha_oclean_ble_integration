"""Brush coverage image entity for the Oclean BLE integration.

Generates an SVG tooth diagram showing which zones were brushed and how
much pressure was applied.  Individual tooth circles are placed along an
elliptical arch and split into inner/outer halves via SVG clip paths.

No external assets or dependencies required — pure Python + math.

Colour coding (adaptive scale):
    grey   → not brushed (pressure 0)
    green  → light pressure   (lower third of session max)
    orange → medium pressure  (middle third)
    red    → high pressure    (upper third)

The scale adapts to the device format automatically:
    0308-extended (OCLEANY3/Z1):   fixed scale 0-255
    021f / Y3P (OCLEANY3P):        relative to session max (observed 0-35)
Any session whose max value exceeds 50 is treated as 0-255 scale.
"""

from __future__ import annotations

import math
from datetime import datetime

from homeassistant.components.image import ImageEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import (
    CONF_DEVICE_NAME,
    CONF_MAC_ADDRESS,
    DATA_DENTAL_CAST,
    DATA_LAST_BRUSH_AREAS,
    DATA_ZONE_HISTORY,
    DOMAIN,
)
from .coordinator import OcleanCoordinator
from .entity import OcleanEntity

# SVG canvas.
_W, _H = 300, 460
_MID_Y = 230  # horizontal divider between upper and lower jaw

# Arch geometry — ellipse parameters for tooth centre positions.
_UPPER = {"cx": _W / 2, "cy": _MID_Y - 8, "rx": 80, "ry": 160, "start": 185, "end": 355}
_LOWER = {"cx": _W / 2, "cy": _MID_Y + 8, "rx": 80, "ry": 160, "start": 5, "end": 175}
_TEETH_PER_JAW = 16
_TOOTH_R = 15

_BG = "#E0E0E0"
_BG_STROKE = "#D0D0D0"


def _effective_scale(areas: dict[str, int]) -> int:
    """Return the pressure scale (max value) for colour mapping.

    Devices using the 0308-extended format (OCLEANY3, Z1) produce values up
    to 255.  Devices using the 021f/gestureArray format (OCLEANY3P) produce
    values in the 0-35 range.  For small ranges (≤ 50) we use the session max
    as scale so that colour differences are visible within a session.
    """
    max_val = max((v for v in areas.values() if v > 0), default=0)
    if max_val == 0:
        return 1  # avoids division by zero; all values are 0 anyway
    if max_val > 100:
        return 255  # 0308-extended (raw ADC, 0-255)
    if max_val <= 50:
        return max_val  # relative scale: gestureArray/021f (0-35 range)
    return 100


def _pressure_to_color(pressure: int, scale: int = 255) -> str | None:
    """Return the fill colour for a pressure value, or None if not brushed.

    Thresholds are expressed as fractions of *scale* so the same colour
    boundaries apply regardless of whether the device reports raw ADC (0-255)
    or a lower-range value (e.g. 0-35 for OCLEANY3P 021f format).
    """
    if pressure <= 0:
        return None
    ratio = pressure / scale
    if ratio <= 80 / 255:   # lower third ≈ 0.314
        return "#4CAF50"    # green
    if ratio <= 160 / 255:  # middle third ≈ 0.627
        return "#FF9800"    # orange
    return "#F44336"        # red


# ------------------------------------------------------------------
# SVG helpers
# ------------------------------------------------------------------


def _tooth_positions(
    cx: float,
    cy: float,
    rx: float,
    ry: float,
    start_deg: float,
    end_deg: float,
    count: int,
) -> list[tuple[float, float]]:
    """Return (x, y) centres for *count* teeth along an elliptical arc."""
    start_rad = math.radians(start_deg)
    end_rad = math.radians(end_deg)
    return [
        (
            cx + rx * math.cos(start_rad + (end_rad - start_rad) * i / (count - 1)),
            cy + ry * math.sin(start_rad + (end_rad - start_rad) * i / (count - 1)),
        )
        for i in range(count)
    ]


# ------------------------------------------------------------------
# SVG generation
# ------------------------------------------------------------------


def _tooth_zone_map(
    n_teeth: int,
    jaw_name: str,
    zone_count: int,
) -> list[str]:
    """Return a list mapping each tooth index to its section name (left/center/right).

    Upper jaw arc: first half = left, second half = right (or left/center/right for 12).
    Lower jaw arc: reversed (first half = right, second half = left).
    """
    if zone_count >= 12:
        third = n_teeth // 3
        sections = ["left"] * third + ["center"] * (n_teeth - 2 * third) + ["right"] * third
    else:
        mid = n_teeth // 2
        sections = ["left"] * mid + ["right"] * (n_teeth - mid)
    if jaw_name == "lower":
        sections = list(reversed(sections))
    return sections


def _semicircle_path(
    tx: float,
    ty: float,
    r: float,
    cx: float,
    cy: float,
    *,
    outer: bool,
) -> str:
    """SVG path for a semicircle split along the radial direction."""
    angle = math.atan2(ty - cy, tx - cx)
    perp = angle + math.pi / 2
    p1x = tx + r * math.cos(perp)
    p1y = ty + r * math.sin(perp)
    p2x = tx - r * math.cos(perp)
    p2y = ty - r * math.sin(perp)
    sweep = 1 if outer else 0
    return f"M {p1x:.1f} {p1y:.1f} A {r} {r} 0 0 {sweep} {p2x:.1f} {p2y:.1f} Z"


def _generate_svg(areas: dict[str, int], zone_count: int = 8) -> str:
    """Generate a complete SVG string for the given brush area pressures.

    Uses per-tooth semicircles for the inner/outer split — no nested
    clip-paths needed.  Each tooth is assigned to its section (left,
    center, right) based on its position in the arc.

    *zone_count* is 8 (default) or 12 for YD-series devices.
    The pressure colour scale adapts automatically to the session's value range.
    """
    scale = _effective_scale(areas)
    elems: list[str] = []

    for jaw_name, jaw in [("upper", _UPPER), ("lower", _LOWER)]:
        cx, cy = jaw["cx"], jaw["cy"]
        rx, ry = jaw["rx"], jaw["ry"]
        start, end = jaw["start"], jaw["end"]

        positions = _tooth_positions(cx, cy, rx, ry, start, end, _TEETH_PER_JAW)
        zone_map = _tooth_zone_map(_TEETH_PER_JAW, jaw_name, zone_count)

        for idx, (tx, ty) in enumerate(positions):
            section = zone_map[idx]
            zone_out = f"{jaw_name}_{section}_out"
            zone_in = f"{jaw_name}_{section}_in"
            color_out = _pressure_to_color(areas.get(zone_out, 0), scale)
            color_in = _pressure_to_color(areas.get(zone_in, 0), scale)

            # Grey background tooth.
            elems.append(
                f'<circle cx="{tx:.1f}" cy="{ty:.1f}" r="{_TOOTH_R}" '
                f'fill="{_BG}" stroke="{_BG_STROKE}" stroke-width="0.3"/>'
            )

            # Outer half (semicircle facing away from arch centre).
            if color_out:
                d = _semicircle_path(tx, ty, _TOOTH_R, cx, cy, outer=True)
                elems.append(f'<path d="{d}" fill="{color_out}" opacity="0.9"/>')

            # Inner half (semicircle facing toward arch centre).
            if color_in:
                d = _semicircle_path(tx, ty, _TOOTH_R, cx, cy, outer=False)
                elems.append(f'<path d="{d}" fill="{color_in}" opacity="0.9"/>')

    # Divider line and labels.
    elems.append(
        f'<line x1="20" y1="{_MID_Y}" x2="{_W - 20}" y2="{_MID_Y}" '
        f'stroke="{_BG_STROKE}" stroke-width="1" stroke-dasharray="4,4"/>'
    )
    elems.append(
        f'<text x="12" y="{_MID_Y + 5}" font-family="Arial,sans-serif" '
        f'font-size="13" fill="#BBB" text-anchor="middle">L</text>'
    )
    elems.append(
        f'<text x="{_W - 12}" y="{_MID_Y + 5}" font-family="Arial,sans-serif" '
        f'font-size="13" fill="#BBB" text-anchor="middle">R</text>'
    )

    elems_str = "\n  ".join(elems)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg"'
        f' viewBox="0 0 {_W} {_H}" width="{_W}" height="{_H}">\n'
        f'  <rect width="{_W}" height="{_H}" fill="white" rx="8"/>\n'
        f"  {elems_str}\n"
        f"</svg>\n"
    )


# ------------------------------------------------------------------
# Home Assistant entity
# ------------------------------------------------------------------


def _zone_history_averages(history: list[dict[str, int]]) -> dict[str, int] | None:
    """Compute per-zone integer averages from a list of session zone dicts."""
    if not history:
        return None
    zone_names = list(history[0].keys())
    return {
        name: round(sum(s.get(name, 0) for s in history) / len(history))
        for name in zone_names
    }


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the Oclean brush coverage image entities."""
    coordinator: OcleanCoordinator = hass.data[DOMAIN][entry.entry_id]
    mac = entry.data[CONF_MAC_ADDRESS]
    device_name = entry.data.get(CONF_DEVICE_NAME, "Oclean")
    async_add_entities([
        OcleanBrushCoverageImage(coordinator, mac, device_name),
        OcleanZoneHeatmapImage(coordinator, mac, device_name),
    ])


class OcleanBrushCoverageImage(OcleanEntity, ImageEntity):
    """Image entity showing a colour-coded brush coverage diagram."""

    _attr_content_type = "image/svg+xml"
    _attr_translation_key = "brush_coverage"

    def __init__(
        self,
        coordinator: OcleanCoordinator,
        mac: str,
        device_name: str,
    ) -> None:
        OcleanEntity.__init__(self, coordinator, mac, device_name, "brush_coverage")
        ImageEntity.__init__(self, coordinator.hass)
        self._cached_image: bytes | None = None
        self._cached_areas: dict[str, int] | None = None

    def _get_areas(self) -> dict[str, int] | None:
        if self.coordinator.data is None:
            return None
        areas = self.coordinator.data.get(DATA_LAST_BRUSH_AREAS)
        return areas if isinstance(areas, dict) else None

    def _handle_coordinator_update(self) -> None:
        """Invalidate cache when area data changes."""
        areas = self._get_areas()
        if areas != self._cached_areas:
            self._cached_areas = areas
            self._cached_image = None
            self._attr_image_last_updated = datetime.now()
        super()._handle_coordinator_update()

    async def async_image(self) -> bytes | None:
        """Return the brush coverage SVG as bytes."""
        areas = self._get_areas()
        if areas is None:
            return None

        if self._cached_image is not None:
            return self._cached_image

        zone_count = 8
        if self.coordinator.data is not None:
            zone_count = self.coordinator.data.get(DATA_DENTAL_CAST, 8)
        self._cached_image = _generate_svg(areas, zone_count=zone_count).encode("utf-8")
        return self._cached_image


class OcleanZoneHeatmapImage(OcleanEntity, ImageEntity):
    """Image entity showing a colour-coded heatmap of average zone pressure.

    Renders the same SVG tooth diagram as OcleanBrushCoverageImage but using
    the rolling per-zone averages across the last ZONE_HISTORY_MAX_SESSIONS
    sessions.  Reveals chronically under-brushed zones at a glance.
    """

    _attr_content_type = "image/svg+xml"
    _attr_translation_key = "zone_heatmap"

    def __init__(
        self,
        coordinator: OcleanCoordinator,
        mac: str,
        device_name: str,
    ) -> None:
        OcleanEntity.__init__(self, coordinator, mac, device_name, "zone_heatmap")
        ImageEntity.__init__(self, coordinator.hass)
        self._cached_image: bytes | None = None
        self._cached_history_len: int = 0

    def _get_history(self) -> list[dict[str, int]] | None:
        if self.coordinator.data is None:
            return None
        history = self.coordinator.data.get(DATA_ZONE_HISTORY)
        return history if isinstance(history, list) and len(history) >= 2 else None

    def _handle_coordinator_update(self) -> None:
        history = self._get_history()
        new_len = len(history) if history else 0
        if new_len != self._cached_history_len:
            self._cached_history_len = new_len
            self._cached_image = None
            self._attr_image_last_updated = datetime.now()
        super()._handle_coordinator_update()

    async def async_image(self) -> bytes | None:
        history = self._get_history()
        if history is None:
            return None

        if self._cached_image is not None:
            return self._cached_image

        averages = _zone_history_averages(history)
        if averages is None:
            return None

        zone_count = 8
        if self.coordinator.data is not None:
            zone_count = self.coordinator.data.get(DATA_DENTAL_CAST, 8)
        self._cached_image = _generate_svg(averages, zone_count=zone_count).encode("utf-8")
        return self._cached_image

    @property
    def available(self) -> bool:
        return self._get_history() is not None
