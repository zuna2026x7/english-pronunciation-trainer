package uk.benext.speak;

import android.Manifest;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 麦克风权限桥接：JS 在每次录音前调用 requestMic。
 * 已授权 -> 直接 resolve；未授权 -> 弹系统授权框，用户点了才继续。
 * 用户之前拒绝过（未勾选“不再询问”）时再次调用会重新弹出授权框。
 * Capacitor 7 写法：权限用 alias 声明 + requestPermissionForAlias + @PermissionCallback。
 */
@CapacitorPlugin(
    name = "MicPermission",
    permissions = @Permission(strings = {Manifest.permission.RECORD_AUDIO}, alias = "mic"))
public class MicPermissionPlugin extends Plugin {

  @PluginMethod
  public void requestMic(PluginCall call) {
    if (getPermissionState("mic") == PermissionState.GRANTED) {
      call.resolve();
      return;
    }
    requestPermissionForAlias("mic", call, "micCallback");
  }

  @PermissionCallback
  private void micCallback(PluginCall call) {
    if (getPermissionState("mic") == PermissionState.GRANTED) {
      call.resolve();
    } else {
      call.reject("mic permission denied");
    }
  }
}
