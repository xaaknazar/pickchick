Pod::Spec.new do |s|
  s.name           = 'PickChickPayments'
  s.version        = '0.1.0'
  s.summary        = 'Card cryptogram and Apple Pay for the PickChick TipTopPay checkout'
  s.author         = 'PickChick'
  s.homepage       = 'https://pickchick.kz'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'PassKit', 'Security'
  s.source_files   = '**/*.swift'
  s.swift_version  = '5.9'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
