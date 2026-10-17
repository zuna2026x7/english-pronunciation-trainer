package uk.benext.speak;

import android.Manifest;
import android.content.pm.PackageManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 麦克风权限桥接：JS 在每次录音前调用 requestMic。
 * 已授权 -> 直接 resolve；未授权 -> 弹系统授权框，用户点了才继续。
 * 用户之前拒绝过（未勾选“不再询问”）时再次调用会重新弹出授权框。
 */
@CapacitorPlugin(name = "MicPermission")
public class MicPermissionPlugin extends Plugin {
  private static final String PERM = Manifest.permission.RECORD_AUDIO;

  @PluginMethod
  public void requestMic(PluginCall call) {
    if (hasPermission(PERM)) {
      call.resolve();
      return;
    }
    saveCall(call);
    requestPermission(PERM);
  }

  @Override
  protected void handleRequestPermissionsResult(
      int requestCode, String[] permissions, int[] grantResults) {
    super.handleRequestPermissionsResult(requestCode, permissions, grantResults);
    PluginCall saved = getSavedCall();
    if (saved == null) return;
    if (grantResults.length > 0
        && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
      saved.resolve();
    } else {
      saved.reject("mic permission denied");
    }
  }
}
