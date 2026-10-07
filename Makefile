# This Makefile is used for managing project level tasks, including cleanup of directory-specific dependencies to ensure a pristine environment for fresh builds or deployments.
# The 'clean' target removes node_modules from specified directories to clear dependencies and reset the project state without leftovers from previous builds.
clean:
	rm -rf ./node_modules # Remove node_modules from the root to clear project-wide dependencies
	rm -rf ./cdk/node_modules # Remove node_modules from the cdk directory to clear CDK-specific dependencies
	echo "Memory is cleaned up"; # Log a message indicating completion of clean up

# `install` target: This target is responsible for installing the node modules
# for the entire project, including a sub-directory named 'cdk'.
# It ensures all necessary JavaScript dependencies are available for development or production.
install: clean
	yarn install # Install root-level dependencies using Yarn
	cd ./cdk && yarn install && cd .. # Navigate to the 'cdk' directory, install its dependencies, then return to the root directory
	echo "Node modules has installed"; # Log a confirmation message to indicate completion of the installation process
