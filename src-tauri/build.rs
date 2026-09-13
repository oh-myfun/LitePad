fn main() {
    // tauri-build 只为 tauri.conf.json / capabilities 声明 rerun-if-changed，
    // 换图标时它不会重跑 → out/resource.rc 与 libresource.a 继续用缓存里的旧图标，
    // `tauri build` 出来的 exe 会一直挂着上一个图标（增量构建下不报错，极易漏掉）。
    // 这里显式盯住 icons 目录，保证改图标后资源一定重新编译。
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
