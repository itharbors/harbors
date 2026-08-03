{
  "targets": [
    {
      "target_name": "harbors_native_credential_vault",
      "sources": ["src/addon.mm"],
      "defines": ["NAPI_VERSION=8"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_LDFLAGS": ["-framework", "Security", "-framework", "LocalAuthentication"]
      }
    }
  ]
}
