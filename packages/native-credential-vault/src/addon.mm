#include <node_api.h>
#include <LocalAuthentication/LocalAuthentication.h>
#include <Security/Security.h>

#include <cstdint>
#include <limits>
#include <string>

#include "status-code.h"

namespace {

template <typename T>
class ScopedCF {
 public:
  explicit ScopedCF(T value = nullptr) : value_(value) {}
  ~ScopedCF() { if (value_ != nullptr) CFRelease(value_); }
  ScopedCF(const ScopedCF&) = delete;
  ScopedCF& operator=(const ScopedCF&) = delete;
  T get() const { return value_; }

 private:
  T value_;
};

bool readString(napi_env env, napi_value value, std::string* output) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
    napi_throw_type_error(env, nullptr, "Credential arguments must be strings");
    return false;
  }
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok
      || length > std::numeric_limits<std::uint32_t>::max()) {
    napi_throw_type_error(env, nullptr, "Credential argument is invalid");
    return false;
  }
  output->resize(length + 1);
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, output->data(), output->size(), &written) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Credential argument is invalid");
    return false;
  }
  output->resize(written);
  return true;
}

void throwMachineCode(napi_env env, const char* machineCode) {
  napi_value message;
  napi_value error;
  napi_value code;
  napi_create_string_utf8(env, "Credential operation failed", NAPI_AUTO_LENGTH, &message);
  napi_create_error(env, nullptr, message, &error);
  napi_create_string_utf8(env, machineCode, NAPI_AUTO_LENGTH, &code);
  napi_set_named_property(env, error, "code", code);
  napi_throw(env, error);
}

void throwStatus(napi_env env, OSStatus status) {
  throwMachineCode(env, harbors::machineCode(harbors::classifySecurityStatus(status)));
}

bool readArguments(napi_env env, napi_callback_info info, size_t expected, napi_value* args) {
  size_t count = expected;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != expected) {
    napi_throw_type_error(env, nullptr, "Invalid credential arguments");
    return false;
  }
  return true;
}

CFStringRef createCFString(const std::string& value) {
  return CFStringCreateWithBytes(
      kCFAllocatorDefault,
      reinterpret_cast<const UInt8*>(value.data()),
      static_cast<CFIndex>(value.size()),
      kCFStringEncodingUTF8,
      false);
}

CFMutableDictionaryRef createQuery(
    CFStringRef service,
    CFStringRef account,
    bool preventAuthenticationUI) {
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(
      kCFAllocatorDefault,
      0,
      &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  if (query == nullptr) return nullptr;
  CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(query, kSecAttrService, service);
  CFDictionarySetValue(query, kSecAttrAccount, account);
  if (preventAuthenticationUI) {
    LAContext* context = [[LAContext alloc] init];
    context.interactionNotAllowed = YES;
    CFDictionarySetValue(query, kSecUseAuthenticationContext, context);
    [context release];
  }
  return query;
}

napi_value GetPassword(napi_env env, napi_callback_info info) {
  napi_value args[2];
  if (!readArguments(env, info, 2, args)) return nullptr;
  std::string serviceText;
  std::string accountText;
  if (!readString(env, args[0], &serviceText) || !readString(env, args[1], &accountText)) return nullptr;

  ScopedCF<CFStringRef> service(createCFString(serviceText));
  ScopedCF<CFStringRef> account(createCFString(accountText));
  if (service.get() == nullptr || account.get() == nullptr) {
    throwMachineCode(env, "OPERATION_FAILED");
    return nullptr;
  }
  ScopedCF<CFMutableDictionaryRef> query(createQuery(service.get(), account.get(), true));
  if (query.get() == nullptr) {
    throwMachineCode(env, "OPERATION_FAILED");
    return nullptr;
  }
  CFDictionarySetValue(query.get(), kSecMatchLimit, kSecMatchLimitOne);
  CFDictionarySetValue(query.get(), kSecReturnData, kCFBooleanTrue);

  CFTypeRef rawResult = nullptr;
  const OSStatus status = SecItemCopyMatching(query.get(), &rawResult);
  ScopedCF<CFTypeRef> result(rawResult);
  const auto classification = harbors::classifySecurityStatus(status);
  if (classification == harbors::SecurityStatusClass::NotFound) {
    napi_value nullValue;
    napi_get_null(env, &nullValue);
    return nullValue;
  }
  if (classification != harbors::SecurityStatusClass::Success
      || result.get() == nullptr
      || CFGetTypeID(result.get()) != CFDataGetTypeID()) {
    if (classification == harbors::SecurityStatusClass::Success) {
      throwMachineCode(env, "OPERATION_FAILED");
    } else {
      throwStatus(env, status);
    }
    return nullptr;
  }

  const auto data = reinterpret_cast<CFDataRef>(result.get());
  napi_value output;
  if (napi_create_string_utf8(
          env,
          reinterpret_cast<const char*>(CFDataGetBytePtr(data)),
          static_cast<size_t>(CFDataGetLength(data)),
          &output) != napi_ok) {
    throwMachineCode(env, "OPERATION_FAILED");
    return nullptr;
  }
  return output;
}

napi_value SetPassword(napi_env env, napi_callback_info info) {
  napi_value args[3];
  if (!readArguments(env, info, 3, args)) return nullptr;
  std::string serviceText;
  std::string accountText;
  std::string secretText;
  if (!readString(env, args[0], &serviceText)
      || !readString(env, args[1], &accountText)
      || !readString(env, args[2], &secretText)) return nullptr;

  ScopedCF<CFStringRef> service(createCFString(serviceText));
  ScopedCF<CFStringRef> account(createCFString(accountText));
  ScopedCF<CFDataRef> secret(CFDataCreate(
      kCFAllocatorDefault,
      reinterpret_cast<const UInt8*>(secretText.data()),
      static_cast<CFIndex>(secretText.size())));
  if (service.get() == nullptr || account.get() == nullptr || secret.get() == nullptr) {
    throwMachineCode(env, "OPERATION_FAILED");
    return nullptr;
  }

  ScopedCF<CFMutableDictionaryRef> query(createQuery(service.get(), account.get(), true));
  ScopedCF<CFMutableDictionaryRef> attributes(CFDictionaryCreateMutable(
      kCFAllocatorDefault,
      0,
      &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks));
  if (query.get() == nullptr || attributes.get() == nullptr) {
    throwMachineCode(env, "OPERATION_FAILED");
    return nullptr;
  }
  CFDictionarySetValue(attributes.get(), kSecValueData, secret.get());
  OSStatus status = SecItemUpdate(query.get(), attributes.get());
  if (status == errSecItemNotFound) {
    ScopedCF<CFMutableDictionaryRef> addition(createQuery(service.get(), account.get(), false));
    if (addition.get() == nullptr) {
      throwMachineCode(env, "OPERATION_FAILED");
      return nullptr;
    }
    CFDictionarySetValue(addition.get(), kSecValueData, secret.get());
    status = SecItemAdd(addition.get(), nullptr);
    if (status == errSecDuplicateItem) {
      status = SecItemUpdate(query.get(), attributes.get());
    }
  }
  if (status != errSecSuccess) {
    throwStatus(env, status);
    return nullptr;
  }

  napi_value undefinedValue;
  napi_get_undefined(env, &undefinedValue);
  return undefinedValue;
}

napi_value DeletePassword(napi_env env, napi_callback_info info) {
  napi_value args[2];
  if (!readArguments(env, info, 2, args)) return nullptr;
  std::string serviceText;
  std::string accountText;
  if (!readString(env, args[0], &serviceText) || !readString(env, args[1], &accountText)) return nullptr;

  ScopedCF<CFStringRef> service(createCFString(serviceText));
  ScopedCF<CFStringRef> account(createCFString(accountText));
  if (service.get() == nullptr || account.get() == nullptr) {
    throwMachineCode(env, "OPERATION_FAILED");
    return nullptr;
  }
  ScopedCF<CFMutableDictionaryRef> query(createQuery(service.get(), account.get(), true));
  if (query.get() == nullptr) {
    throwMachineCode(env, "OPERATION_FAILED");
    return nullptr;
  }

  const OSStatus status = SecItemDelete(query.get());
  if (status == errSecItemNotFound) {
    napi_value result;
    napi_get_boolean(env, false, &result);
    return result;
  }
  if (status != errSecSuccess) {
    throwStatus(env, status);
    return nullptr;
  }
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    {"getPassword", nullptr, GetPassword, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setPassword", nullptr, SetPassword, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"deletePassword", nullptr, DeletePassword, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, 3, properties) != napi_ok) return nullptr;
  return exports;
}
