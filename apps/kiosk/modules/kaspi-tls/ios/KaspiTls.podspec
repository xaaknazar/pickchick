Pod::Spec.new do |s|
  s.name           = 'KaspiTls'
  s.version        = '0.1.0'
  s.summary        = 'HTTPS to the kiosk Kaspi Smart POS with a pinned leaf certificate (ADR-0018)'
  s.author         = 'PickChick'
  s.homepage       = 'https://pickchick.kz'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'Security', 'CryptoKit'
  s.source_files   = '**/*.swift'
  s.swift_version  = '5.9'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
