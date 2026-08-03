#pragma once

#include <Security/Security.h>

namespace harbors {

enum class SecurityStatusClass {
  Success,
  NotFound,
  Locked,
  Unavailable,
  AccessDenied,
  OperationFailed,
};

inline SecurityStatusClass classifySecurityStatus(OSStatus status) {
  switch (status) {
    case errSecSuccess:
      return SecurityStatusClass::Success;
    case errSecItemNotFound:
      return SecurityStatusClass::NotFound;
    case errSecInteractionNotAllowed:
      return SecurityStatusClass::Locked;
    case errSecNotAvailable:
    case errSecNoSuchKeychain:
    case errSecInvalidKeychain:
      return SecurityStatusClass::Unavailable;
    case errSecAuthFailed:
    case errSecUserCanceled:
      return SecurityStatusClass::AccessDenied;
    default:
      return SecurityStatusClass::OperationFailed;
  }
}

inline const char* machineCode(SecurityStatusClass status) {
  switch (status) {
    case SecurityStatusClass::Locked:
      return "BACKEND_LOCKED";
    case SecurityStatusClass::Unavailable:
      return "BACKEND_UNAVAILABLE";
    case SecurityStatusClass::AccessDenied:
      return "ACCESS_DENIED";
    default:
      return "OPERATION_FAILED";
  }
}

}  // namespace harbors
