//! 原子写入：临时文件 → fsync → rename 覆盖。
//!
//! 目标：任何时刻磁盘上都只有「旧版本」或「新版本」，绝不出现半截文件
//! （断电/崩溃时尤其重要）。

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;

/// 写入 `path`，保证原子性。失败时清理临时文件并返回错误。
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
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn write_and_swap(tmp: &Path, target: &Path, data: &[u8]) -> io::Result<()> {
    let mut f = File::create(tmp)?;
    f.write_all(data)?;
    // 先落盘数据，再改名，保证 rename 后内容已持久
    f.sync_all()?;
    drop(f);

    match fs::rename(tmp, target) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Windows：目标被占用或跨卷时 rename 可能失败，退化为先删后改。
            // 这一步会短暂失去原子性，属于兜底路径。
            match fs::remove_file(target) {
                Ok(()) => fs::rename(tmp, target).map_err(|_| e),
                Err(remove_err) => Err(io::Error::new(
                    remove_err.kind(),
                    format!("覆盖失败：{}", e),
                )),
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
