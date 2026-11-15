import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultDesignV2 } from "@onden/site";
import { ApiError } from "../../../lib/api";
import { setLocalePref } from "../../../lib/i18n";

const uploadMedia = vi.hoisted(() => vi.fn(async (_file: File) => "/api/media/new-logo.png"));
const addToast = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/data", async (original) => ({ ...(await original<typeof import("../../../lib/data")>()), uploadMedia }));
vi.mock("../../../lib/appStore", async (original) => ({ ...(await original<typeof import("../../../lib/appStore")>()), addToast }));

const { default: SiteSettingsPanel } = await import("./SiteSettingsPanel");

const base = { brand: "My site", tagline: "", logo: "", favicon: "" };
function mount(info = base) {
  const onInfo = vi.fn();
  render(<SiteSettingsPanel design={defaultDesignV2({})} onStyle={vi.fn()} onCss={vi.fn()} info={info} onInfo={onInfo} />);
  return onInfo;
}
const field = (name: string) => screen.getByRole("group", { name });
const fileInput = (name: string) => field(name).querySelector("input[type=file]") as HTMLInputElement;
const choose = (name: string, file: File) => fireEvent.change(fileInput(name), { target: { files: [file] } });
const png = (name = "logo.png") => new File(["x"], name, { type: "image/png" });

beforeEach(() => { setLocalePref("zh-TW"); uploadMedia.mockClear(); addToast.mockClear(); });
afterEach(cleanup);

describe("標誌與網站圖示", () => {
  it("shows both fields under the site name, with the icon's one-line explanation", () => {
    mount();
    expect(field("標誌")).toBeInTheDocument();
    expect(field("網站圖示")).toHaveTextContent("瀏覽器分頁上的小圖示");
    expect(within(field("標誌")).getByRole("button", { name: "上傳圖片" })).toBeEnabled();
    expect(within(field("標誌")).queryByRole("button", { name: "移除" })).toBeNull();
    expect(within(field("標誌")).queryByRole("img")).toBeNull();
  });

  it("a finished upload goes to onInfo as the logo, and shows 上傳中… meanwhile", async () => {
    let finish: (url: string) => void = () => {};
    uploadMedia.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const onInfo = mount();
    choose("標誌", png());
    const button = await within(field("標誌")).findByRole("button", { name: "上傳中…" });
    expect(button).toBeDisabled();
    expect(onInfo).not.toHaveBeenCalled();
    finish("/api/media/new-logo.png");
    await waitFor(() => expect(onInfo).toHaveBeenCalledWith({ logo: "/api/media/new-logo.png" }));
    expect(onInfo).toHaveBeenCalledTimes(1);
  });

  it("the site icon is saved as favicon, not as the logo", async () => {
    uploadMedia.mockResolvedValueOnce("/api/media/icon.png");
    const onInfo = mount();
    choose("網站圖示", png("icon.png"));
    await waitFor(() => expect(onInfo).toHaveBeenCalledWith({ favicon: "/api/media/icon.png" }));
  });

  it("shows the current picture without its address, and 移除 saves an empty string", () => {
    const onInfo = mount({ ...base, logo: "/api/media/old.png" });
    const picture = within(field("標誌")).getByRole("img");
    expect(picture).toHaveAttribute("src", "/api/media/old.png");
    expect(field("標誌").textContent).not.toContain("/api/media");
    fireEvent.click(within(field("標誌")).getByRole("button", { name: "移除" }));
    expect(onInfo).toHaveBeenCalledWith({ logo: "" });
  });

  it("a failed upload reports once and changes nothing", async () => {
    uploadMedia.mockRejectedValueOnce(new ApiError(500, "boom"));
    const onInfo = mount({ ...base, logo: "/api/media/old.png" });
    choose("標誌", png());
    await waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
    expect(addToast.mock.calls[0]![0]).not.toMatch(/boom|500/);
    expect(onInfo).not.toHaveBeenCalled();
    expect(within(field("標誌")).getByRole("img")).toHaveAttribute("src", "/api/media/old.png");
    expect(within(field("標誌")).getByRole("button", { name: "上傳圖片" })).toBeEnabled();
  });

  it("refuses a file that is not an image before uploading anything", () => {
    const onInfo = mount();
    choose("標誌", new File(["x"], "notes.pdf", { type: "application/pdf" }));
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(onInfo).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith("請選擇 PNG、JPG、WebP 或 SVG 圖片。", "error");
  });

  it("only offers png, jpg, webp and svg in the picker", () => {
    mount();
    const accept = fileInput("標誌").accept;
    for (const kind of ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]) expect(accept).toContain(kind);
    expect(accept).not.toMatch(/gif|image\/\*/);
  });

  it("speaks English in the English interface", () => {
    setLocalePref("en");
    mount();
    expect(field("Logo")).toBeInTheDocument();
    expect(field("Site icon")).toHaveTextContent("The small icon on the browser tab");
  });
});

describe("自己寫樣式 and @import", () => {
  const withCss = (css: string) => render(<SiteSettingsPanel design={{ ...defaultDesignV2({}), css }} onStyle={vi.fn()} onCss={vi.fn()} info={base} onInfo={vi.fn()} />);
  it("says @import is not supported when the CSS has one, however it is written", () => {
    withCss("@import url(https://fonts.googleapis.com/css2?family=Inter);\na{color:red}");
    expect(screen.getByRole("status")).toHaveTextContent("不支援 @import");
  });
  it("says nothing for CSS without one", () => {
    withCss("a{color:red}");
    expect(screen.queryByText(/不支援 @import/)).toBeNull();
  });
});
