//! 原子写入：临时文件 → fsync → rename 覆盖。
//!
//! 目标：任何时刻磁盘上都只有「旧版本」或「新版本」，绝不出现半截文件
//! （断电/崩溃时尤其重要）。

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;

use crate::core::logging::{self, Level};

/// 写入 `path`，保证原子性。失败时清理临时文件并返回错误。
///
/// ⚠️ 这里是**所有**落盘路径的公共底座（设置 / 会话 / 备份 / 保存文件都走它），
/// 所以失败必须留下一条：调用方大多会把错误转成给前端的提示，但「磁盘满了」
/// 「文件被占用」这类原因只有记在这里才查得到（B144）。
pub fn atomic_write(path: &Path, data: &[u8]) -> io::Result<()> {
    // 临时文件必须与目标同卷，否则 rename 会退化成拷贝、失去原子性
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "litepad".to_string());
    let tmp = dir.join(format!(".{}.{}.tmp", file_name, std::process::id()));

    let result = write_and_swap(&tmp, path, data);
    if let Err(ref e) = result {
        logging::log(
            Level::Error,
            "atomic_write",
            &format!("写入失败：{e} ← {}", path.display()),
        );
        // 临时文件清理不掉不算致命，但值得记一笔：反复看得到说明目标目录不可写。
        if let Err(rm) = fs::remove_file(&tmp) {
            logging::log(
                Level::Debug,
                "atomic_write",
                &format!("临时文件残留：{rm} ← {}", tmp.display()),
            );
        }
    }
    result
}

fn write_and_swap(tmp: &Path, target: &Path, data: &[u8]) -> io::Result<()> {
    write_and_swap_inner(tmp, target, data)
}

fn write_and_swap_inner(tmp: &Path, target: &Path, data: &[u8]) -> io::Result<()> {
    let mut f = File::create(tmp)?;
    f.write_all(data)?;
    // 先落盘数据，再改名，保证 rename 后内容已持久
    f.sync_all()?;
    drop(f);

    match fs::rename(tmp, target) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Windows：目标被占用或跨卷时 rename 可能失败，退化为先删后改。
            // 这一步会短暂失去原子性，属于兜底路径，得留下「为什么没走上 rename」。
            match fs::remove_file(target) {
                Ok(()) => fs::rename(tmp, target).map_err(|_| e),
                Err(remove_err) => {
                    let err = io::Error::new(remove_err.kind(), format!("覆盖失败：{}", e));
                    logging::log(
                        Level::Warn,
                        "atomic_write",
                        &format!("{err} ← {}", target.display()),
                    );
                    Err(err)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_overwrites() {
        let dir = std::env::temp_dir().join(format!("litepad-atomic-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("a.txt");

        atomic_write(&target, b"first").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "first");

        atomic_write(&target, b"second-and-longer").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "second-and-longer");

        // 临时文件必须已清理
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "临时文件未清理");

        fs::remove_dir_all(&dir).ok();
    }
}
