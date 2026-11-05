// B431 · 链接插入弹窗（照 InkNote `src/components/LinkInsertDialog.tsx` 的两栏表单）。
//
// 与 B406 的图片弹窗同壳：`.settings-overlay` + `.settings-dialog`，挂 document.body
//（装饰面在 `.cm-scroller` 里，有独立层叠上下文，挂进编辑器会被外壳压住）。
//
// 规范化口径照 InkNote：带协议（`scheme:`）、以 `/` 或 `#` 开头的按原样用，
// 其余补 `https://`。文本留空时回落成 URL —— 与 `[url](url)` 的可读性一致。

import { setTip } from "./tooltip";

export interface LinkDialogResult {
  text: string;
  url: string;
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("#")) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

/** 打开链接插入弹窗；取消返回 null。 */
export function showLinkDialog(defaultText: string): Promise<LinkDialogResult | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "settings-overlay";

    const dialog = document.createElement("div");
    dialog.className = "settings-dialog image-dialog";

    const title = document.createElement("div");
    title.className = "save-confirm-title";
    title.textContent = "插入链接";

    const textField = document.createElement("div");
    textField.className = "image-dialog-field";
    const textLabel = document.createElement("label");
    textLabel.className = "image-dialog-label";
    textLabel.htmlFor = "link-dialog-text";
    textLabel.textContent = "文本";
    const textControl = document.createElement("div");
    textControl.className = "image-dialog-control";
    const textInput = document.createElement("input");
    textInput.id = "link-dialog-text";
    textInput.type = "text";
    textInput.value = defaultText;
    textInput.placeholder = "链接文字（可空，默认用地址）";
    textControl.appendChild(textInput);
    textField.append(textLabel, textControl);

    const urlField = document.createElement("div");
    urlField.className = "image-dialog-field";
    const urlLabel = document.createElement("label");
    urlLabel.className = "image-dialog-label";
    urlLabel.htmlFor = "link-dialog-url";
    urlLabel.textContent = "链接";
    const urlControl = document.createElement("div");
    urlControl.className = "image-dialog-control";
    const urlInput = document.createElement("input");
    urlInput.id = "link-dialog-url";
    urlInput.type = "text";
    urlInput.value = "https://";
    urlInput.placeholder = "https://example.com";
    urlControl.appendChild(urlInput);
    urlField.append(urlLabel, urlControl);

    const actions = document.createElement("div");
    actions.className = "save-confirm-actions image-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "save-confirm-btn save-confirm-secondary";
    cancel.textContent = "取消";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "save-confirm-btn save-confirm-primary";
    confirm.textContent = "确定";
    actions.append(cancel, confirm);

    dialog.append(title, textField, urlField, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const syncConfirm = () => {
      confirm.disabled = !normalizeUrl(urlInput.value);
    };
    syncConfirm();

    let settled = false;
    const close = (result: LinkDialogResult | null): void => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      resolve(result);
    };
    const submit = (): void => {
      const url = normalizeUrl(urlInput.value);
      if (!url) {
        urlInput.focus();
        return;
      }
      const text = textInput.value.trim() || url;
      close({ text, url });
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      }
    };

    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) close(null);
    });
    urlInput.addEventListener("input", syncConfirm);
    dialog.addEventListener("keydown", onKeyDown);
    cancel.addEventListener("click", () => close(null));
    confirm.addEventListener("click", submit);
    setTip(cancel, "取消");
    setTip(confirm, "插入链接");

    // 有选中文字就把光标交给地址栏（文字多半就是要保留的）；否则先填文字。
    if (defaultText.trim()) {
      urlInput.focus();
      urlInput.select();
    } else {
      textInput.focus();
    }
  });
}
