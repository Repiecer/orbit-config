#!/usr/bin/env python3
"""
从系统安装的 Nerd Font 生成精选图标库 orbitconfig/nerd_icons.json。

Nerd Font 打补丁字体里带 post 表（format 2.0），保存了每个字形的 PostScript
名字（如 md-web / fa-github / dev-rust）。这里手写一个最小的 TTF 解析器把
cmap + post 读出来，得到「名字 → 码点」的权威映射，再按下面的分类精选。

重新生成：
    python3 tools/build_icons.py
可选参数指定字体：
    python3 tools/build_icons.py /path/to/SomeNerdFont.ttf
"""

import glob
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)
OUTPUT_PATH = os.path.join(PROJECT_ROOT, "orbitconfig", "nerd_icons.json")

FONT_CANDIDATES = [
    "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf",
    "/usr/share/fonts/TTF/JetBrainsMonoNerdFontMono-Regular.ttf",
    "/usr/share/fonts/TTF/*NerdFont*Regular.ttf",
    "/usr/share/fonts/**/*NerdFont*Regular.ttf",
]

CATEGORIES = [
    ("常用", "md-apps md-apps_box md-star md-star_outline md-heart md-heart_outline "
             "md-bookmark md-home md-account md-account_multiple md-cog md-magnify "
             "md-bell md-calendar md-clock_outline md-fire md-lightning_bolt md-flag "
             "md-pin md-map_marker md-compass md-plus md-check md-close md-arrow_right "
             "md-chevron_right md-menu md-view_grid md-dots_grid md-shape md-puzzle "
             "md-tag md-ticket md-gift md-trophy md-medal md-crown md-rocket_launch "
             "md-robot md-emoticon md-cat md-dog"),
    ("终端与开发", "md-console md-console_line md-code_tags md-code_braces md-code_json "
                   "md-language_python md-language_cpp md-language_javascript "
                   "md-language_typescript md-language_rust md-language_go "
                   "md-language_java md-language_html5 md-language_css3 "
                   "md-language_markdown md-xml md-sitemap md-source_branch "
                   "md-source_merge md-git md-github md-gitlab md-bitbucket md-docker "
                   "md-kubernetes md-database md-server md-server_network md-api md-bug "
                   "md-bug_outline md-test_tube md-flask md-function md-variable "
                   "md-identifier md-numeric md-regex md-math_integral md-matrix "
                   "md-memory md-cpu_64_bit md-chip md-expansion_card md-raspberry_pi "
                   "dev-arduino md-usb md-harddisk md-nas md-wrench md-hammer "
                   "md-screwdriver md-tools md-cog_outline md-cogs md-application_cog "
                   "md-tune md-tune_variant md-package_variant md-package md-archive "
                   "md-zip_box md-file_code md-file_code_outline md-script_text "
                   "md-script_text_outline md-powershell dev-bash md-linux "
                   "md-arch dev-ubuntu md-ubuntu dev-linux"),
    ("网络与社交", "md-web md-earth md-globe_model md-link md-link_variant md-open_in_new "
                   "md-wifi md-wifi_strength_4 md-cloud md-cloud_outline md-cloud_download "
                   "md-cloud_upload md-cloud_sync md-shield_lock md-vpn md-lan "
                   "md-router_wireless md-access_point md-dns md-domain md-wall "
                   "md-search_web md-email md-email_outline md-send md-chat md-chat_outline "
                   "md-message md-forum md-account_group md-share_variant md-rss "
                   "md-bell_ring md-at md-phone md-cellphone md-qrcode md-barcode md-webcam "
                   "fa-github fa-gitlab fa-youtube_play md-youtube md-twitter dev-twitter "
                   "fa-reddit fa-discord fa-telegram fa-facebook fa-instagram "
                   "fa-linkedin_in md-linkedin dev-stackoverflow fa-spotify fa-twitch "
                   "fa-steam fa-android md-apple fa-windows fa-linux fa-chrome md-firefox "
                   "fa-edge fa-safari fa-opera fa-docker fa-python fa-js fa-node_js "
                   "md-nodejs fa-react fa-vuejs fa-angular dev-rust fa-java fa-php "
                   "fa-wordpress fa-weixin fa-qq fa-weibo fa-zhihu fa-bluetooth "
                   "fa-bluetooth_b"),
    ("媒体", "md-music md-music_note md-playlist_music md-video md-movie md-movie_open "
             "md-filmstrip md-play_circle md-television md-television_classic md-camera "
             "md-camera_outline md-camera_iris md-image md-image_multiple md-palette "
             "md-brush md-draw md-pencil md-format_paint md-headphones md-speaker "
             "md-volume_high md-microphone md-radio md-podcast md-gamepad_variant "
             "md-controller_classic md-cards_playing md-dice_5 md-chess_knight md-book "
             "md-book_open_page_variant md-bookshelf md-library md-newspaper "
             "md-file_pdf_box md-file_document md-file_music md-file_video md-subtitles"),
    ("文件与办公", "md-folder md-folder_outline md-folder_open md-folder_multiple md-file "
                   "md-file_outline md-file_document_outline md-file_table md-file_excel "
                   "md-file_word md-file_powerpoint md-file_image md-file_cloud "
                   "md-file_download md-file_upload md-clipboard md-clipboard_text md-note "
                   "md-note_text md-notebook md-printer md-paperclip md-download md-upload "
                   "md-trash_can md-content_copy md-content_cut md-content_paste "
                   "md-backup_restore fa-dropbox fa-google_drive md-google_drive "
                   "md-microsoft_onedrive"),
    ("系统与工具", "md-monitor md-monitor_dashboard md-desktop_classic md-laptop md-tablet "
                   "md-watch md-mouse md-keyboard md-scanner md-projector md-power "
                   "md-power_plug md-power_standby md-battery md-battery_charging "
                   "md-weather_sunny md-weather_night md-brightness_6 md-eye md-eye_outline "
                   "md-speedometer md-chart_line md-chart_bar md-chart_pie md-chart_donut "
                   "md-poll md-trending_up md-snowflake md-water md-weather_windy "
                   "md-thermometer md-timer md-timer_outline md-calendar_clock md-alarm "
                   "md-history md-update md-sync md-refresh md-restart md-lock md-lock_open "
                   "md-shield md-shield_check md-key md-key_variant md-fingerprint "
                   "md-incognito md-alert md-alert_circle md-information md-help "
                   "md-help_circle md-check_circle md-close_circle md-minus_circle "
                   "md-plus_circle md-exclamation md-skull md-virus md-biohazard "
                   "fa-radiation md-eye_off md-broom md-vacuum md-washing_machine "
                   "md-microwave md-fridge"),
    ("生活与其它", "md-home_city md-office_building md-store md-cart md-cash "
                   "md-credit_card md-wallet md-bank md-currency_usd md-currency_cny "
                   "md-airplane md-car md-bike md-bus md-train md-walk md-map "
                   "md-weather_sunset md-beach md-basketball md-soccer md-football "
                   "md-dumbbell md-yoga md-run md-food md-food_apple md-pizza md-coffee "
                   "md-glass_cocktail md-cake md-ice_cream md-leaf md-flower md-tree md-paw "
                   "md-bird md-fish md-baby_face md-human md-account_child md-school "
                   "md-book_education md-medical_bag md-hospital_building md-pill "
                   "md-stethoscope md-heart_pulse md-umbrella md-glasses md-tshirt_crew "
                   "md-shoe_sneaker md-ring md-diamond_stone md-party_popper md-balloon "
                   "md-candy"),
]

# 现有配置里已经在用的图标（真实字形名），保证永远出现在「常用」分类顶部
PINNED = [
    "md-console_line", "md-web", "md-github", "md-magnify", "md-google",
    "md-robot", "md-application", "md-speedometer", "md-lightbulb_on",
    "md-broom", "md-fish", "md-video", "md-wallpaper",
    "md-keyboard_backspace", "md-apple_keyboard_command",
    "md-apps", "md-star", "md-folder", "md-home", "md-heart",
]


# ── 极简 TTF 解析 ────────────────────────────────────────────────────────────

def read_tables(path):
    with open(path, "rb") as handle:
        data = handle.read()
    num_tables = struct.unpack(">H", data[4:6])[0]
    tables = {}
    offset = 12
    for _ in range(num_tables):
        tag = data[offset:offset + 4].decode("latin1")
        pos, length = struct.unpack(">II", data[offset + 8:offset + 16])
        tables[tag] = (pos, length)
        offset += 16
    return data, tables


def parse_post_names(data, offset, length):
    version = struct.unpack(">I", data[offset:offset + 4])[0]
    if version != 0x00020000:
        return []
    num_glyphs = struct.unpack(">H", data[offset + 32:offset + 34])[0]
    indices = []
    pos = offset + 34
    for _ in range(num_glyphs):
        indices.append(struct.unpack(">H", data[pos:pos + 2])[0])
        pos += 2
    strings = []
    end = offset + length
    while pos < end:
        size = data[pos]
        pos += 1
        if size == 0:
            break
        strings.append(data[pos:pos + size].decode("latin1"))
        pos += size
    # post format 2.0: 索引 < 258 指向 Mac 标准字形名，>= 258 才指向自定义
    # 字符串数组（偏移 258）。这里只关心自定义名，所以 < 258 一律忽略。
    return [strings[i - 258] if 258 <= i - 258 < len(strings) else None for i in indices]


def parse_cmap(data, offset):
    _, num_tables = struct.unpack(">HH", data[offset:offset + 4])
    best = None
    for i in range(num_tables):
        pos = offset + 4 + i * 8
        pid, eid, sub = struct.unpack(">HHI", data[pos:pos + 8])
        best = (pid, eid, offset + sub)
    _, _, sub = best
    fmt = struct.unpack(">H", data[sub:sub + 2])[0]
    mapping = {}
    if fmt == 4:
        seg_x2 = struct.unpack(">H", data[sub + 6:sub + 8])[0]
        seg = seg_x2 // 2
        ends = struct.unpack(">%dH" % seg, data[sub + 14:sub + 14 + seg_x2])
        starts = struct.unpack(">%dH" % seg, data[sub + 16 + seg_x2:sub + 16 + 2 * seg_x2])
        deltas = struct.unpack(">%dh" % seg, data[sub + 16 + 2 * seg_x2:sub + 16 + 3 * seg_x2])
        ro_base = sub + 16 + 3 * seg_x2
        ros = struct.unpack(">%dH" % seg, data[ro_base:ro_base + seg_x2])
        for i in range(seg):
            for code in range(starts[i], ends[i] + 1):
                if code == 0xFFFF:
                    continue
                if ros[i] == 0:
                    glyph = (code + deltas[i]) & 0xFFFF
                else:
                    at = ro_base + ros[i] * 2 + (code - starts[i]) * 2
                    glyph = struct.unpack(">H", data[at:at + 2])[0]
                    if glyph:
                        glyph = (glyph + deltas[i]) & 0xFFFF
                if glyph:
                    mapping[code] = glyph
    elif fmt == 12:
        count = struct.unpack(">I", data[sub + 12:sub + 16])[0]
        pos = sub + 16
        for _ in range(count):
            start, end, gid = struct.unpack(">III", data[pos:pos + 12])
            pos += 12
            for code in range(start, end + 1):
                mapping[code] = gid + (code - start)
    return mapping


def font_index(path):
    data, tables = read_tables(path)
    cmap_offset, _ = tables["cmap"]
    post_offset, post_length = tables.get("post", (0, 0))
    names = parse_post_names(data, post_offset, post_length) if post_offset else []
    mapping = parse_cmap(data, cmap_offset)
    index = {}
    for code, glyph in mapping.items():
        if glyph < len(names) and names[glyph]:
            index.setdefault(names[glyph], code)
    return index


def find_font(explicit=None):
    if explicit:
        return explicit if os.path.isfile(explicit) else None
    for candidate in FONT_CANDIDATES:
        for path in sorted(glob.glob(candidate, recursive=True)):
            if os.path.isfile(path):
                return path
    return None


def main():
    explicit = sys.argv[1] if len(sys.argv) > 1 else None
    font_path = find_font(explicit)
    if not font_path:
        print("找不到 Nerd Font，请显式传入字体路径。", file=sys.stderr)
        return 1
    print(f"使用字体: {font_path}")
    index = font_index(font_path)
    print(f"解析到 {len(index)} 个具名字形")

    categories = []
    missing = []
    seen = set()

    pinned_entries = []
    for name in PINNED:
        if name not in index:
            missing.append(("常用（置顶）", name))
            continue
        if name in seen:
            continue
        seen.add(name)
        pinned_entries.append({
            "n": name,
            "c": index[name],
            "l": name.split("-", 1)[-1].replace("_", " "),
        })

    for title, names in CATEGORIES:
        entries = []
        for name in names.split():
            if name not in index:
                missing.append((title, name))
                continue
            if name in seen:
                if title == "常用":
                    continue
                continue
            seen.add(name)
            entries.append({
                "n": name,
                "c": index[name],
                "l": name.split("-", 1)[-1].replace("_", " "),
            })
        if entries:
            categories.append({"name": title, "icons": entries})

    if pinned_entries:
        pinned_entries.extend(categories[0]["icons"] if categories and categories[0]["name"] == "常用" else [])
        rest = categories[1:] if categories and categories[0]["name"] == "常用" else categories
        categories = [{"name": "常用", "icons": pinned_entries}] + rest

    payload = {
        "source_font": os.path.basename(font_path),
        "categories": categories,
        "total": sum(len(c["icons"]) for c in categories),
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))

    print(f"写出 {OUTPUT_PATH}（{payload['total']} 个图标）")
    if missing:
        print(f"字体中缺失 {len(missing)} 个名字（已跳过）:", file=sys.stderr)
        for title, name in missing:
            print(f"  - [{title}] {name}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
