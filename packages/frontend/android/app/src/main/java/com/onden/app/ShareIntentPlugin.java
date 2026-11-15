package com.onden.app;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 「分享 → Onden」 on Android: receives ACTION_SEND / ACTION_SEND_MULTIPLE
 * (text/plain, image/*; intent filters in AndroidManifest.xml) and holds the
 * share until the web app takes it (src/lib/share/shareInbox.ts).
 *
 * The share is kept, not pushed, because a cold start from the share sheet
 * first shows the server and login gates: the workspace calls take() once it
 * is mounted. A share while the app is already open fires "shareReceived",
 * and the workspace takes it then.
 *
 * Images are read on take(), off the main thread, and sent as base64; the
 * grant to read a shared content:// URI lasts while this activity lives.
 * A file over MAX_FILE_BYTES is skipped (the server's image cap is smaller).
 */
@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {

    private static final String TAG = "ShareIntent";
    private static final int MAX_FILES = 10;
    private static final long MAX_FILE_BYTES = 25L * 1024 * 1024;

    private static final class PendingShare {
        String title;
        String text;
        final List<Uri> streams = new ArrayList<>();
        String type;
    }

    private PendingShare pending;

    // BridgeActivity hands the launching intent here too (on load), so a cold
    // start and a share into the running app take the same path.
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        PendingShare share = readIntent(intent);
        if (share == null) return;
        synchronized (this) {
            pending = share;
        }
        // Consumed: a later activity re-creation must not deliver it again.
        getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
        notifyListeners("shareReceived", new JSObject());
    }

    private static PendingShare readIntent(Intent intent) {
        if (intent == null) return null;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return null;
        PendingShare share = new PendingShare();
        share.type = intent.getType();
        share.title = stringExtra(intent, Intent.EXTRA_SUBJECT);
        if (share.title == null) share.title = stringExtra(intent, Intent.EXTRA_TITLE);
        share.text = stringExtra(intent, Intent.EXTRA_TEXT);
        if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = streamExtra(intent);
            if (uri != null) share.streams.add(uri);
        } else {
            ArrayList<Uri> uris = streamListExtra(intent);
            if (uris != null) {
                for (Uri uri : uris) {
                    if (uri != null && share.streams.size() < MAX_FILES) share.streams.add(uri);
                }
            }
        }
        if (share.title == null && share.text == null && share.streams.isEmpty()) return null;
        return share;
    }

    private static String stringExtra(Intent intent, String key) {
        CharSequence value = intent.getCharSequenceExtra(key);
        if (value == null) return null;
        String text = value.toString().trim();
        return text.isEmpty() ? null : text;
    }

    @SuppressWarnings("deprecation")
    private static Uri streamExtra(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    @SuppressWarnings("deprecation")
    private static ArrayList<Uri> streamListExtra(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
        return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
    }

    /** Resolve { share: { title, text, files: [{ name, mimeType, data }] } | null } and forget it. */
    @PluginMethod
    public void take(final PluginCall call) {
        final PendingShare share;
        synchronized (this) {
            share = pending;
            pending = null;
        }
        if (share == null) {
            // { } — no share waiting (the web side reads a missing `share`).
            call.resolve(new JSObject());
            return;
        }
        getBridge().execute(() -> {
            JSObject out = new JSObject();
            out.put("title", share.title);
            out.put("text", share.text);
            JSArray files = new JSArray();
            ContentResolver resolver = getContext().getContentResolver();
            for (Uri uri : share.streams) {
                try {
                    JSObject file = readFile(resolver, uri, share.type);
                    if (file != null) files.put(file);
                } catch (Exception e) {
                    Logger.error(TAG, "Could not read a shared file", e);
                }
            }
            out.put("files", files);
            JSObject result = new JSObject();
            result.put("share", out);
            call.resolve(result);
        });
    }

    private static JSObject readFile(ContentResolver resolver, Uri uri, String fallbackType) throws Exception {
        String mime = resolver.getType(uri);
        if (mime == null) mime = fallbackType;
        String name = displayName(resolver, uri);
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) return null;
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024];
            long total = 0;
            int read;
            while ((read = in.read(buffer)) != -1) {
                total += read;
                if (total > MAX_FILE_BYTES) {
                    Logger.warn(TAG, "Skipped a shared file over the size limit");
                    return null;
                }
                bytes.write(buffer, 0, read);
            }
            JSObject file = new JSObject();
            file.put("name", name);
            file.put("mimeType", mime);
            file.put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
            return file;
        }
    }

    private static String displayName(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && !name.isEmpty()) return name;
            }
        } catch (Exception ignored) {
            // fall back to the URI's last segment
        }
        return uri.getLastPathSegment();
    }
}
