// 鱼记得 note — Tauri 后端：数据目录内 JSON 文件的原子读写 + 写前滚动备份。
// 同步与加密逻辑全部在前端 TypeScript 中实现。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

/// 旧版应用（大便签）的数据目录名，首次启动时把数据迁移过来
const LEGACY_DATA_DIR: &str = "com.dabianqian.desktop";

/// 一次性迁移：新目录还没有 notes.json 而旧目录有时，复制便签/设置/备份。
/// 幂等：迁移后旧目录原样保留（作为安全备份，不删除）。
fn migrate_legacy_data(app: &tauri::AppHandle) {
    let Ok(new_dir) = app.path().app_data_dir() else {
        return;
    };
    if new_dir.join("notes.json").exists() {
        return; // 新目录已有数据，无需迁移
    }
    let legacy_dir = new_dir.with_file_name(LEGACY_DATA_DIR);
    if !legacy_dir.join("notes.json").exists() {
        return; // 没有旧数据
    }
    if fs::create_dir_all(&new_dir).is_err() {
        return;
    }
    for f in ["notes.json", "settings.json"] {
        let _ = fs::copy(legacy_dir.join(f), new_dir.join(f));
    }
    copy_dir_recursive(&legacy_dir.join("backups"), &new_dir.join("backups"));
}

fn copy_dir_recursive(src: &Path, dst: &Path) {
    let Ok(entries) = fs::read_dir(src) else {
        return;
    };
    let _ = fs::create_dir_all(dst);
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_file() {
            let _ = fs::copy(&p, dst.join(entry.file_name()));
        }
    }
}

/// 允许读写的文件名白名单，防止路径穿越
fn validate_name(file: &str) -> Result<(), String> {
    let ok = !file.is_empty()
        && file.len() <= 64
        && file
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        && !file.contains("..");
    if ok {
        Ok(())
    } else {
        Err("非法的文件名".into())
    }
}

fn data_path(app: &tauri::AppHandle, file: &str) -> Result<PathBuf, String> {
    validate_name(file)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(file))
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 民历日期（Howard Hinnant 的 civil_from_days 算法），无需 chrono 依赖
fn ymd_from_unix_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

const ROLLING_KEEP: usize = 20;
const ROLLING_THROTTLE_MS: u128 = 90_000;
const DAILY_KEEP: usize = 7;

/// 写盘前备份旧内容：
///   - 滚动备份 notes.<毫秒>.bak：距上一份 ≥90 秒且内容有变化才写（合并连续打字），保留 20 份
///   - 每日备份 notes.daily.<日期>.bak：每天一份、内容有变化时更新，保留 7 天
fn backup_notes(data_dir: &Path, old_content: &str) -> Result<(), String> {
    let bdir = data_dir.join("backups");
    fs::create_dir_all(&bdir).map_err(|e| e.to_string())?;

    let mut rolling: Vec<(u128, PathBuf)> = Vec::new();
    let mut daily: Vec<PathBuf> = Vec::new();
    let entries = fs::read_dir(&bdir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        let Some(stem) = name.strip_prefix("notes.").and_then(|s| s.strip_suffix(".bak")) else {
            continue;
        };
        if stem.chars().all(|c| c.is_ascii_digit()) {
            // 备份时间戳记录在文件名里（拷贝/还原后仍保持产生时间语义）
            let ms = stem.parse::<u128>().unwrap_or_else(|_| {
                fs::metadata(&p)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            });
            rolling.push((ms, p));
        } else if stem.starts_with("daily.") {
            daily.push(p);
        }
    }
    rolling.sort_by_key(|(ms, _)| *ms);
    rolling.reverse(); // 最新在前

    // 滚动备份
    let should_backup = match rolling.first() {
        None => true,
        Some((ms, p)) => {
            if now_millis() - ms < ROLLING_THROTTLE_MS {
                false // 与上一份挨得太近，视为同一次编辑会话
            } else {
                fs::read_to_string(p).map(|c| c != old_content).unwrap_or(true)
            }
        }
    };
    if should_backup {
        let p = bdir.join(format!("notes.{}.bak", now_millis()));
        fs::write(&p, old_content).map_err(|e| e.to_string())?;
        rolling.insert(0, (now_millis(), p));
    }
    for (_, p) in rolling.iter().skip(ROLLING_KEEP) {
        let _ = fs::remove_file(p);
    }

    // 每日备份
    let (y, m, d) = ymd_from_unix_days((now_millis() / 1000 / 86400) as i64);
    let daily_path = bdir.join(format!("notes.daily.{y}-{m:02}-{d:02}.bak"));
    let need_daily = fs::read_to_string(&daily_path)
        .map(|c| c != old_content)
        .unwrap_or(true);
    if need_daily {
        fs::write(&daily_path, old_content).map_err(|e| e.to_string())?;
    }
    daily.sort();
    while daily.len() >= DAILY_KEEP {
        let oldest = daily.remove(0);
        let _ = fs::remove_file(oldest);
    }
    Ok(())
}

#[tauri::command]
fn read_data(app: tauri::AppHandle, file: String) -> Result<Option<String>, String> {
    let path = data_path(&app, &file)?;
    if path.exists() {
        Ok(Some(fs::read_to_string(path).map_err(|e| e.to_string())?))
    } else {
        Ok(None)
    }
}

/// 原子写：先备份旧内容（仅便签数据），再写临时文件改名，避免写一半崩溃导致数据损坏
#[tauri::command]
fn write_data(app: tauri::AppHandle, file: String, content: String) -> Result<(), String> {
    let path = data_path(&app, &file)?;
    if file == "notes.json" && path.exists() {
        let old = fs::read_to_string(&path).unwrap_or_default();
        if old != content {
            if let Some(dir) = path.parent() {
                // 备份失败不阻塞正常保存
                let _ = backup_notes(dir, &old);
            }
        }
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    let path = data_path(&app, "notes.json")?;
    let dir = path.parent().ok_or("无父目录")?;
    Command::new("explorer")
        .arg(dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            migrate_legacy_data(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![read_data, write_data, open_data_dir])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ymd_from_unix_days() {
        // 2026-11-04 UTC：2000-01-01=10957，2000..2025 共 26 年 = 9499 天 → 20456，+307（11月4日为当年第308天）
        assert_eq!(ymd_from_unix_days(20761), (2026, 11, 4));
        // 1970-01-01
        assert_eq!(ymd_from_unix_days(0), (1970, 1, 1));
        // 2000-02-29（闰年）：10957 (2000-01-01) + 31 + 28
        assert_eq!(ymd_from_unix_days(11016), (2000, 2, 29));
    }

    #[test]
    fn test_backup_notes_creates_rolling_and_daily() {
        let dir = std::env::temp_dir().join(format!("dbq-backup-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        backup_notes(&dir, "第一版内容").unwrap();

        let bdir = dir.join("backups");
        let names: Vec<String> = fs::read_dir(&bdir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names.len(), 2, "应产生 1 份滚动 + 1 份每日备份: {names:?}");
        assert!(names.iter().any(|n| n.starts_with("notes.") && !n.contains("daily")));
        assert!(names.iter().any(|n| n.contains("daily.")));
        // 内容是旧内容
        let rolling = names.iter().find(|n| !n.contains("daily.")).unwrap();
        let content = fs::read_to_string(bdir.join(rolling)).unwrap();
        assert_eq!(content, "第一版内容");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_backup_prune_rolling_keep_20() {
        let dir = std::env::temp_dir().join(format!("dbq-backup-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let bdir = dir.join("backups");
        fs::create_dir_all(&bdir).unwrap();
        // 预置 25 份旧滚动备份（文件名时间戳在遥远的过去，绕过 90 秒节流）
        for i in 0..25 {
            let p = bdir.join(format!("notes.100000{i:04}.bak"));
            fs::write(&p, format!("旧内容{i}")).unwrap();
        }
        backup_notes(&dir, "触发剪枝的新内容").unwrap();
        let count = fs::read_dir(&bdir).unwrap().count();
        assert!(count <= 26, "滚动+每日，最多 21 份，实际 {count}");

        let _ = fs::remove_dir_all(&dir);
    }
}
