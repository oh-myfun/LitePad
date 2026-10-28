// B406 · 图片编辑弹窗（照 InkNote `src/components/ImageInsertDialog.tsx` 的两栏表单）。
//
// 只做「替代文本 + 图片路径」两格：InkNote 的弹窗也是这两格 + 浏览键；
// 标题（`![alt](path "title")` 的 title）不在表单里，由调用方原样保留。
//
// ⚠️ 壳层用应用既有的 `.settings-overlay` + `.settings-dialog`（与未保存确认框同款）：
// 装饰面在 `.cm-scroller` 里，而那一层有 `z-index: 0` 的独立层叠上下文（B405）——
// 弹窗必须挂 `document.body`，挂进编辑器里会被应用外壳压住。

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { setTip } from "./tooltip";

export interface ImageDialogResult {
  alt: string;
  path: string;
}

export interface ImageDialogOptions {
  /** 预填的替代文本（图片语法里 `[]` 那一截）。 */
  alt: string;
  /** 预填的图片地址（Markdown 里原样的那一段，不是解析后的绝对路径）。 */
  path: string;
  /** 浏览按钮；测试可注入，缺省走系统文件选择器。 */
  browse?: () => Promise<string | null>;
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"];

async function browseImageFile(): Promise<string | null> {
  try {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "图片", extensions: IMAGE_EXTENSIONS }],
    });
    return typeof picked === "string" ? picked : null;
  } catch {
    // 原生对话框不可用（jsdom / 权限缺失）时当作「没选」
    return null;
  }
}

/** 打开图片编辑弹窗；取消返回 null。 */
export function showImageDialog(opts: ImageDialogOptions): Promise<ImageDialogResult | null> {
  const browse = opts.browse ?? browseImageFile;
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "settings-overlay";

    const dialog = document.createElement("div");
    dialog.className = "settings-dialog image-dialog";

    const title = document.createElement("div");
    title.className = "save-confirm-title";
    title.textContent = "编辑图片";

    const altField = document.createElement("div");
    altField.className = "image-dialog-field";
    const altLabel = document.createElement("label");
    altLabel.className = "image-dialog-label";
    altLabel.htmlFor = "image-dialog-alt";
    altLabel.textContent = "替代文本";
    const altControl = document.createElement("div");
    altControl.className = "image-dialog-control";
    const altInput = document.createElement("input");
    altInput.id = "image-dialog-alt";
    altInput.type = "text";
    altInput.value = opts.alt;
    altInput.placeholder = "图片说明（可空）";
    altControl.appendChild(altInput);
    altField.append(altLabel, altControl);

    const pathField = document.createElement("div");
    pathField.className = "image-dialog-field";
    const pathLabel = document.createElement("label");
    pathLabel.className = "image-dialog-label";
    pathLabel.htmlFor = "image-dialog-path";
    pathLabel.textContent = "图片路径";
    const pathControl = document.createElement("div");
    pathControl.className = "image-dialog-control";
    const pathInput = document.createElement("input");
    pathInput.id = "image-dialog-path";
    pathInput.type = "text";
    pathInput.value = opts.path;
    pathInput.placeholder = "相对路径或绝对路径";
    const browseBtn = document.createElement("button");
    browseBtn.type = "button";
    browseBtn.className = "save-confirm-btn save-confirm-secondary image-dialog-browse";
    browseBtn.textContent = "浏览…";
    setTip(browseBtn, "选择图片文件");
    pathControl.append(pathInput, browseBtn);
    pathField.append(pathLabel, pathControl);

    const actions = document.createElement("div");
    actions.className = "save-confirm-actions image-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "save-confirm-btn save-confirm-secondary image-dialog-cancel";
    cancel.textContent = "取消";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "save-confirm-btn save-confirm-primary image-dialog-confirm";
    confirm.textContent = "确定";
    actions.append(cancel, confirm);

    dialog.append(title, altField, pathField, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const syncConfirm = () => {
      confirm.disabled = !pathInput.value.trim();
    };
    syncConfirm();

    let settled = false;
    const close = (result: ImageDialogResult | null): void => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      resolve(result);
    };
    const submit = () => {
      const path = pathInput.value.trim();
      if (!path) return;
      close({ alt: altInput.value.trim(), path });
    };

    // 冒泡阶段停在弹窗上：全局快捷键（Ctrl+S / Ctrl+N…）挂在 window/document 的冒泡段，
    // 到这里就断了；输入框自己的默认打字行为不受影响。
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(null);
        return;
      }
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
        event.preventDefault();
        event.stopPropagation();
        submit();
        return;
      }
      event.stopPropagation();
    };

    pathInput.addEventListener("input", syncConfirm);
    browseBtn.addEventListener("click", () => {
      void (async () => {
        const picked = await browse();
        if (!picked) return;
        pathInput.value = picked;
        syncConfirm();
        pathInput.focus();
      })();
    });
    cancel.addEventListener("click", () => close(null));
    confirm.addEventListener("click", submit);
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) close(null);
    });
    dialog.addEventListener("keydown", onKeyDown);

    altInput.focus();
    altInput.select();
  });
}
