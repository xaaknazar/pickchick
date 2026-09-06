#!/usr/bin/env ruby
# frozen_string_literal: true

# Run on macOS with the same isolated xcodeproj gems as CocoaPods, e.g.
# GEM_HOME=<CocoaPods libexec> ruby tests/mobile/ios_simulator_signing_test.rb
require 'fileutils'
require 'open3'
require 'pathname'
require 'rbconfig'
require 'tmpdir'
require 'xcodeproj'

root = Pathname.new(__dir__).join('../..').realpath
script = root.join('scripts/mobile/ios_ui_smoke.rb')
assert = ->(condition, message) { raise message unless condition }
run = lambda do |*args|
  output, status = Open3.capture2e(*args.map(&:to_s))
  raise "Command failed: #{args.first}\n#{output[-8000..] || output}" unless status.success?
  output
end
Dir.mktmpdir('pickchick-signing-') do |directory|
  fixture = Pathname.new(directory)
  project_path = fixture.join('PickChick.xcodeproj')
  project = Xcodeproj::Project.new(project_path)
  app = project.new_target(:application, 'PickChick', :ios, '16.4')
  app.build_configurations.each do |config|
    config.build_settings.merge!(
      'PRODUCT_BUNDLE_IDENTIFIER' => 'kz.pickchick.signing-fixture',
      'PRODUCT_NAME' => 'PickChick',
      'GENERATE_INFOPLIST_FILE' => 'YES',
      'DEVELOPMENT_TEAM' => 'DAJTP6MC3Q',
      'CODE_SIGN_STYLE' => 'Automatic',
      'CODE_SIGN_ENTITLEMENTS' => 'Physical.entitlements',
      'CODE_SIGN_IDENTITY[sdk=iphoneos*]' => 'Apple Development',
      'PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]' => 'PhysicalProfileMustStay'
    )
  end
  physical_entitlements = { 'com.apple.developer.associated-domains' => ['applinks:fixture.invalid'] }
  Xcodeproj::Plist.write_to_path(physical_entitlements, fixture.join('Physical.entitlements'))
  main = fixture.join('main.m')
  main.write("#import <UIKit/UIKit.h>\nint main(int argc, char *argv[]) { @autoreleasepool { return UIApplicationMain(argc, argv, nil, nil); } }\n")
  app.source_build_phase.add_file_reference(project.main_group.new_file('main.m'))
  project.save
  original = project_path.join('project.pbxproj').read
  app_before = app.build_configurations.to_h { |config| [config.name, Marshal.load(Marshal.dump(config.build_settings))] }
  project_before = project.build_configurations.to_h { |config| [config.name, Marshal.load(Marshal.dump(config.build_settings))] }
  arguments = [RbConfig.ruby, script, '--project', project_path, '--source', root.join('tests/mobile/ios/SmokeTests.swift')]
  run.call(*arguments)
  assert.call(project_path.join('project.pbxproj').read == original, 'Dry run changed project')
  assert.call(!fixture.join('.pickchick-ui-smoke').exist?, 'Dry run wrote entitlements')
  run.call(*arguments, '--install')
  installed = project_path.join('project.pbxproj').read
  scheme_path = project_path.join('xcshareddata/xcschemes/PickChickUITests.xcscheme')
  scheme = scheme_path.read
  generated_path = fixture.join('.pickchick-ui-smoke/Simulator.entitlements')
  generated = generated_path.read
  run.call(*arguments, '--install')
  assert.call(project_path.join('project.pbxproj').read == installed, 'Second install changed project')
  assert.call(scheme_path.read == scheme, 'Second install changed scheme')
  assert.call(generated_path.read == generated, 'Second install changed entitlements')
  after = Xcodeproj::Project.open(project_path)
  actual = after.targets.find { |target| target.name == 'PickChick' }
  after.build_configurations.each do |config|
    assert.call(config.build_settings == project_before[config.name], 'Project-level configuration changed')
  end
  actual.build_configurations.each do |config|
    kept = config.build_settings.reject { |key, _| key.end_with?('[sdk=iphonesimulator*]') }
    assert.call(kept == app_before[config.name], 'Physical/unconditional app signing changed')
    if config.name == 'Debug'
      assert.call(config.build_settings == app_before['Debug'], 'Debug app settings changed')
    else
      assert.call(config.build_settings['CODE_SIGNING_ALLOWED[sdk=iphonesimulator*]'] == 'YES', 'Simulator signing remains disabled')
      assert.call(config.build_settings['CODE_SIGN_IDENTITY[sdk=iphonesimulator*]'] == '-', 'Simulator identity is not ad-hoc')
    end
  end
  assert.call(Xcodeproj::Plist.read_from_path(fixture.join('Physical.entitlements')) == physical_entitlements, 'Physical entitlements changed')
  assert.call(after.targets.count { |target| target.name == 'PickChickUITests' } == 1, 'Duplicate test targets')
  # No simulator is booted, installed or controlled. A tiny application is built
  # only to prove Xcode expands and signs the actual Keychain entitlement values.
  build_output = run.call('xcodebuild', '-project', project_path, '-target', 'PickChick', '-configuration', 'Release',
           '-sdk', 'iphonesimulator', "SYMROOT=#{fixture.join('build')}", "OBJROOT=#{fixture.join('intermediates')}")
  built = fixture.join('build/Release-iphonesimulator/PickChick.app')
  # Xcode stores simulator entitlements in the Mach-O __TEXT section, while
  # the ad-hoc code-signature entitlement dictionary is intentionally empty.
  run.call('codesign', '--verify', '--strict', built)
  section = run.call('xcrun', 'otool', '-X', '-s', '__TEXT', '__entitlements', built.join('PickChick'))
  simulated = fixture.glob('intermediates/**/*.app-Simulated.xcent').first
  assert.call(simulated, 'Xcode did not generate simulator entitlement source')
  signed = Xcodeproj::Plist.read_from_path(simulated)
  identifier = 'DAJTP6MC3Q.kz.pickchick.signing-fixture'
  assert.call(signed['application-identifier'] == identifier, 'Simulator app identifier not expanded')
  assert.call(signed['keychain-access-groups'] == [identifier], 'Simulator Keychain group not expanded')
  assert.call(build_output.include?('-sectcreate') && build_output.include?('__entitlements') && build_output.include?('PickChick.app-Simulated.xcent'), 'Linker omitted simulator entitlements')
  assert.call(section.lines.any? { |line| line.match?(/^[0-9a-f]{8,16}\s/i) }, 'Built Mach-O has no simulator entitlements section')
  binary = File.binread(built.join('PickChick'))
  assert.call(binary.include?('application-identifier') && binary.include?('keychain-access-groups') && binary.include?(identifier), 'Built executable omits Keychain identity')
  puts 'PASS: dry run, repeated install, unchanged device/archive/Debug signing, and actual ad-hoc signature and linked simulator Keychain entitlements.'
end
