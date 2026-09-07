#!/usr/bin/env ruby
# frozen_string_literal: true

require 'optparse'
require 'pathname'
require 'fileutils'

ROOT = Pathname.new(__dir__).join('../..').realpath
MARKER = 'PICKCHICK_UI_SMOKE_GENERATED'
SIMULATOR_ENTITLEMENTS = '.pickchick-ui-smoke/Simulator.entitlements'
SIMULATOR_ENTITLEMENTS_CONTENT = <<~PLIST.freeze
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <!-- PICKCHICK_UI_SMOKE_GENERATED: simulator-only Keychain access -->
  <plist version="1.0">
  <dict>
    <key>application-identifier</key>
    <string>$(DEVELOPMENT_TEAM).$(PRODUCT_BUNDLE_IDENTIFIER)</string>
    <key>keychain-access-groups</key>
    <array><string>$(DEVELOPMENT_TEAM).$(PRODUCT_BUNDLE_IDENTIFIER)</string></array>
    <key>com.apple.developer.team-identifier</key>
    <string>$(DEVELOPMENT_TEAM)</string>
  </dict>
  </plist>
PLIST

options = {
  app: 'mobile',
  project: nil,
  source: nil,
  install: false
}
parser = OptionParser.new do |opts|
  opts.banner = 'Usage: ruby scripts/mobile/ios_ui_smoke.rb [--install] [--project PATH]'
  opts.separator 'Default: inspect and describe the change without writing or building.'
  opts.on('--install', 'Configure UI tests and simulator-only Release Keychain signing') { options[:install] = true }
  opts.on('--app APP', %w[mobile kiosk], 'Allowlisted PickChick app (mobile or kiosk)') { |value| options[:app] = value }
  opts.on('--project PATH', 'Generated PickChick.xcodeproj (also useful for a fixture)') { |value| options[:project] = Pathname.new(value).expand_path }
  opts.on('--source PATH', 'Override the checked-in Swift UI-test source') { |value| options[:source] = Pathname.new(value).expand_path }
  opts.on('-h', '--help') { puts opts; exit }
end
parser.parse!
abort parser.to_s unless ARGV.empty?
app_name = options[:app] == 'kiosk' ? 'PickChickKiosk' : 'PickChick'
target_name = options[:app] == 'kiosk' ? 'PickChickKioskUITests' : 'PickChickUITests'
test_bundle = options[:app] == 'kiosk' ? 'kz.pickchick.kiosk.ui-smoke' : 'kz.pickchick.ui-smoke'
options[:project] ||= ROOT.join("apps/#{options[:app]}/ios/#{app_name}.xcodeproj")
options[:source] ||= ROOT.join("tests/#{options[:app]}/ios/SmokeTests.swift")

# Homebrew CocoaPods bundles its own gems. Reuse that isolated installation;
# never install gems or change the user's Ruby environment on disk.
begin
  require 'xcodeproj'
rescue LoadError
  pod = ENV.fetch('PATH', '').split(File::PATH_SEPARATOR)
           .map { |dir| File.join(dir, 'pod') }.find { |path| File.file?(path) && File.executable?(path) }
  wrapper = pod && File.size(pod) < 65_536 ? File.read(pod) : ''
  gem_home = ENV['PICKCHICK_POD_GEM_HOME'] || wrapper[/GEM_HOME="([^"]+)"/, 1]
  abort 'xcodeproj is unavailable. Run with the GEM_HOME used by your CocoaPods installation, or set PICKCHICK_POD_GEM_HOME to its libexec directory. No global installation is needed.' unless gem_home && File.directory?(gem_home)
  ENV['GEM_HOME'] = gem_home
  Gem.clear_paths
  require 'xcodeproj'
end

project_path = options[:project]
source_path = options[:source]
abort "Generated project missing: #{project_path}. Run the mobile Expo iOS prebuild first." unless project_path.join('project.pbxproj').file?
abort "Test source missing: #{source_path}" unless source_path.file?

project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |target| target.name == app_name && target.product_type == 'com.apple.product-type.application' }
abort "Expected application target #{app_name} was not found; no project changes made." unless app
release = app.build_configurations.find { |config| config.name == 'Release' }
abort 'Expected application Release configuration was not found; no project changes made.' unless release
entitlements_path = project_path.dirname.join(SIMULATOR_ENTITLEMENTS)
if entitlements_path.file? && !entitlements_path.read.include?(MARKER)
  abort "#{entitlements_path} is not owned by this script; no project changes made."
end
target = project.targets.find { |candidate| candidate.name == target_name }
if target && (target.product_type != 'com.apple.product-type.bundle.ui-testing' || target.build_configurations.any? { |config| config.build_settings[MARKER] != 'YES' })
  abort "#{target_name} already exists and is not owned by this script; no project changes made."
end

puts "Project: #{project_path}"
puts "Source: #{source_path}"
puts "#{target ? 'Update' : 'Add'} #{target_name} (#{test_bundle}), app dependency #{app_name}, separate shared Release scheme."
puts 'App Release for iphonesimulator only: ad-hoc signing with generated application identifier and Keychain group. Device/archive signing stays unchanged.'
unless options[:install]
  puts 'Dry run: no files written. Use --install after native-build coordination.'
  exit
end

target ||= project.new_target(:ui_test_bundle, target_name, :ios, '16.4', nil, :swift)
group = project.main_group.groups.find { |candidate| candidate.name == 'PickChickUISmoke' } || project.main_group.new_group('PickChickUISmoke')
relative_source = source_path.relative_path_from(project_path.dirname).to_s
reference = group.files.find { |file| file.path == relative_source } || group.new_file(relative_source)
target.source_build_phase.add_file_reference(reference) unless target.source_build_phase.files_references.include?(reference)
target.add_dependency(app) unless target.dependencies.any? { |dependency| dependency.target == app }

# An unsigned simulator application can launch, but SecureStore fails with -34018.
# Do not use a global CODE_SIGNING_ALLOWED=NO build override: it takes precedence
# over these application settings and removes the Keychain identity again.
release.build_settings.merge!(
  'CODE_SIGNING_ALLOWED[sdk=iphonesimulator*]' => 'YES',
  'CODE_SIGNING_REQUIRED[sdk=iphonesimulator*]' => 'YES',
  'CODE_SIGN_IDENTITY[sdk=iphonesimulator*]' => '-',
  'CODE_SIGN_STYLE[sdk=iphonesimulator*]' => 'Manual',
  'PROVISIONING_PROFILE_SPECIFIER[sdk=iphonesimulator*]' => '',
  'CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]' => SIMULATOR_ENTITLEMENTS
)
FileUtils.mkdir_p(entitlements_path.dirname)
entitlements_path.write(SIMULATOR_ENTITLEMENTS_CONTENT)

target.build_configurations.each do |config|
  config.build_settings.merge!(
    MARKER => 'YES',
    'PRODUCT_BUNDLE_IDENTIFIER' => test_bundle,
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'TEST_TARGET_NAME' => app.name,
    'SWIFT_VERSION' => '5.0',
    'IPHONEOS_DEPLOYMENT_TARGET' => '16.4',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'CLANG_ENABLE_MODULES' => 'YES',
    'ENABLE_TESTING_SEARCH_PATHS' => 'YES',
    'CODE_SIGNING_ALLOWED[sdk=iphonesimulator*]' => 'NO',
    'CODE_SIGNING_REQUIRED[sdk=iphonesimulator*]' => 'NO'
  )
end
attributes = project.root_object.attributes['TargetAttributes'] ||= {}
attributes[target.uuid] ||= {}
attributes[target.uuid]['TestTargetID'] = app.uuid

scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.add_build_target(target, false)
scheme.add_test_target(target)
scheme.set_launch_target(app)
scheme.test_action.build_configuration = 'Release'
scheme.launch_action.build_configuration = 'Release'
scheme.profile_action.build_configuration = 'Release'
scheme.analyze_action.build_configuration = 'Release'
project.save
scheme.save_as(project_path, target_name, true)
puts 'Installed. Only simulator Release signing changed on the application; device/archive signing and its existing scheme are unchanged. No build, simulator, archive or upload was started.'
