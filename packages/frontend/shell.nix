{ pkgs ? import <nixpkgs> {} }:

let
  androidEnv = pkgs.androidenv.composeAndroidPackages {
    buildToolsVersions = [ "34.0.0" ];
    platformVersions = [ "34" ];
    abiVersions = [ "arm64-v8a" "x86_64" ];
  };
in pkgs.mkShell {
  packages = [ pkgs.jdk17 androidEnv.androidsdk pkgs.android-tools ];
  ANDROID_HOME = "${androidEnv.androidsdk}/libexec/android-sdk";
  ANDROID_SDK_ROOT = "${androidEnv.androidsdk}/libexec/android-sdk";
}
