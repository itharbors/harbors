#include <cassert>
#include <Security/Security.h>

#include "../src/status-code.h"

int main() {
  using harbors::SecurityStatusClass;
  using harbors::classifySecurityStatus;

  assert(classifySecurityStatus(errSecSuccess) == SecurityStatusClass::Success);
  assert(classifySecurityStatus(errSecItemNotFound) == SecurityStatusClass::NotFound);
  assert(classifySecurityStatus(errSecInteractionNotAllowed) == SecurityStatusClass::Locked);
  assert(classifySecurityStatus(errSecNotAvailable) == SecurityStatusClass::Unavailable);
  assert(classifySecurityStatus(errSecAuthFailed) == SecurityStatusClass::AccessDenied);
  assert(classifySecurityStatus(errSecUserCanceled) == SecurityStatusClass::AccessDenied);
  assert(classifySecurityStatus(-34018) == SecurityStatusClass::OperationFailed);
  return 0;
}
